/* Docker-backed integration test for the web stack (static Vite apps without React).
 *
 * A plain TypeScript Vite app goes through the CLI with no stack named: detection has to pick
 * the static path, not a Node.js runtime. A real `vite build` runs in the Node build stage and
 * the output is served by the shared Go static server on distroless/static. The cache policy
 * and SPA details the React test covers in depth come from the same server and are only
 * spot-checked here.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

const available = H.dockerAvailable();
const skip = available ? false : "no Linux Docker daemon reachable";

test("web/vite: non-React Vite app is detected as static web and served without Node.js", { skip, timeout: 2400000 }, async (t) => {
  const dir = H.copyFixture("vite-static");
  const tag = "distroless-setup-it/vite-static:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  const out = H.runCli(null, dir);
  assert.match(out, /Static web \(Vite\)/, "detection should pick the static web stack");
  assert.doesNotMatch(out, /distroless Node\.js image/, "a Vite build toolchain is not a Node.js runtime");

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /^ARG VITE_API_URL$/m);
  assert.match(dockerfile, /^ARG VITE_APP_TITLE$/m);
  const runtime = dockerfile.slice(dockerfile.indexOf("AS serve"));
  assert.match(runtime, /^FROM gcr\.io\/distroless\/static-debian13:nonroot AS serve$/m);
  assert.match(runtime, /COPY --from=build --chown=65532:0 \/app\/dist \/app\/www/);
  assert.doesNotMatch(runtime, /node_modules|npm|node:/, "the runtime stage must not carry Node.js or node_modules");

  H.buildImage(dir, tag, ["--build-arg", "VITE_APP_TITLE=Vite Static Built", "--build-arg", "VITE_API_URL=https://api.vite-static.example"]);
  H.assertNoShellOrPackageManager(tag);
  for (const bin of ["node", "/nodejs/bin/node", "npx"]) {
    const r = H.docker("run", "--rm", "--entrypoint", bin, tag, "--version");
    assert.notEqual(r.status, 0, `'${bin}' should not exist in the runtime image`);
  }

  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, [], "the static runtime should need no writable paths");
  container = H.startContainer(tag, { port: 8080, args: ro.args });

  const index = await H.waitForHttp(container, "/");
  assert.match(index.body, /<title>Vite Static Built<\/title>/);
  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  const assets = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(js|css))"/g)].map((m) => ({ url: m[1], ext: m[2] }));
  assert.ok(assets.some((a) => a.ext === "js") && assets.some((a) => a.ext === "css"), `expected hashed JS and CSS in index.html:\n${index.body}`);
  for (const a of assets) {
    const r = await H.http(container.url + a.url);
    assert.equal(r.status, 200, `${a.url} should be served`);
    if (a.ext === "js") assert.match(r.body, /https:\/\/api\.vite-static\.example/, "VITE_API_URL from --build-arg should be inlined");
  }
  const deep = await H.http(`${container.url}/some/client/route`);
  assert.equal(deep.status, 200);
  assert.equal(deep.body, index.body, "unknown paths fall back to index.html");

  const started = Date.now();
  H.dockerMust("docker stop", "stop", "-t", "20", container.id);
  assert.ok(Date.now() - started < 15000, "SIGTERM should stop the server promptly");
  assert.equal(H.inspect(container.id, "{{.State.ExitCode}}"), "0");
});
