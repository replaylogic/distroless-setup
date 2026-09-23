/* Docker-backed integration test for the React stack.
 *
 * A real React + Vite + TypeScript app with client-side routing goes through the real CLI,
 * a real `vite build` inside `docker build`, and the shared Go static server on
 * distroless/static. Everything is probed from outside the running container.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const H = require("./helpers");

const available = H.dockerAvailable();
const skip = available ? false : "no Linux Docker daemon reachable";

const IMMUTABLE = "public, max-age=31536000, immutable";
const NO_STORE = "no-cache, no-store, must-revalidate";

test("react/vite: static SPA on distroless/static, build-time env, caching, SPA fallback, SIGTERM", { skip, timeout: 2400000 }, async (t) => {
  const dir = H.copyFixture("react-vite");
  const tag = "distroless-setup-it/react-vite:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  // A developer's local override. It must never reach the image: the generated
  // .dockerignore keeps it out of the build context.
  fs.writeFileSync(path.join(dir, ".env.local"), "VITE_API_URL=https://leaked-from-env-local.invalid\n");

  H.runCli("react", dir);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /^ARG VITE_API_URL$/m, "each client variable found should be a build ARG");
  assert.match(dockerfile, /^ARG VITE_APP_TITLE$/m, "variables used in index.html should be found too");
  assert.match(dockerfile, /^RUN npm run build$/m);
  const runtime = dockerfile.slice(dockerfile.indexOf("AS serve"));
  assert.match(runtime, /COPY --from=build --chown=65532:0 \/app\/dist \/app\/www/, "only the Vite output goes into the runtime");
  assert.doesNotMatch(runtime, /node_modules|npm|node:/, "the runtime stage must not carry Node.js or node_modules");

  const ignore = H.readGenerated(dir, ".dockerignore").split(/\r?\n/);
  for (const entry of [".env", ".env.*", "!.env.example", "*.pem"]) assert.ok(ignore.includes(entry), `.dockerignore should contain ${entry}`);

  const report = H.readGenerated(dir, "DISTROLESS-MIGRATION.md");
  assert.match(report, /Setting `VITE_\*` on the running container does not change an already-built browser bundle\./);
  assert.match(report, /`VITE_API_URL` \| Vite `VITE_\*` \| `src\/App\.tsx:\d+`/);

  H.buildImage(dir, tag, ["--build-arg", "VITE_APP_TITLE=Built With Args", "--build-arg", "VITE_API_URL=https://api.build-arg.example"]);
  H.assertNoShellOrPackageManager(tag);

  // The report says nothing needs to be writable; run under exactly that, and set a client
  // variable at runtime to prove it has no effect on the built bundle.
  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, [], "the static runtime should need no writable paths");
  container = H.startContainer(tag, { port: 8080, args: ro.args, env: { VITE_APP_TITLE: "Set At Runtime" } });

  const index = await H.waitForHttp(container, "/");
  assert.match(index.body, /<title>Built With Args<\/title>/, "the build arg should be compiled into index.html");
  assert.doesNotMatch(index.body, /Set At Runtime/, "a runtime env var must not change the built app");
  assert.equal(index.headers.get("cache-control"), NO_STORE, "index.html must not be long-lived cached");
  assert.equal(index.headers.get("x-content-type-options"), "nosniff");
  assert.equal(index.headers.get("x-frame-options"), "SAMEORIGIN");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);
  const health = await H.http(`${container.url}/healthz`);
  assert.equal(health.status, 200);
  assert.match(health.body, /ok/);

  // Client-side routes, including nested ones, are answered with the app.
  for (const route of ["/about", "/users/123", "/some/deep/route"]) {
    const r = await H.http(container.url + route);
    assert.equal(r.status, 200, `${route} should fall back to index.html`);
    assert.equal(r.body, index.body, `${route} should serve the app shell`);
  }

  // Hashed bundles from the real Vite build: served, immutable, with the build-time value inlined.
  const assets = [...index.body.matchAll(/(?:src|href)="(\/assets\/[^"]+\.(js|css))"/g)].map((m) => ({ url: m[1], ext: m[2] }));
  assert.ok(assets.some((a) => a.ext === "js") && assets.some((a) => a.ext === "css"), `expected hashed JS and CSS in index.html:\n${index.body}`);
  for (const a of assets) {
    const r = await H.http(container.url + a.url);
    assert.equal(r.status, 200, `${a.url} should be served`);
    assert.equal(r.headers.get("cache-control"), IMMUTABLE, `${a.url} is content-hashed and should be immutable`);
    assert.match(r.headers.get("content-type"), a.ext === "js" ? /javascript/ : /text\/css/);
    if (a.ext === "js") {
      assert.match(r.body, /https:\/\/api\.build-arg\.example/, "VITE_API_URL from --build-arg should be inlined in the bundle");
      assert.doesNotMatch(r.body, /leaked-from-env-local/, ".env.local must not reach the build");
      const gz = await H.http(container.url + a.url, { headers: { "Accept-Encoding": "gzip" } });
      assert.equal(gz.headers.get("content-encoding"), "gzip", "the bundle should be served pre-compressed");
    }
  }

  // An unversioned file from public/ keeps its name when it changes: never immutable.
  const favicon = await H.http(`${container.url}/favicon.svg`);
  assert.equal(favicon.status, 200);
  assert.equal(favicon.headers.get("cache-control"), "no-cache", "an unversioned public asset must be revalidated");

  // A stale client asking for a bundle from an older deploy gets a 404, not HTML as JavaScript.
  const missing = await H.http(`${container.url}/assets/index-DEADBEEF.js`);
  assert.equal(missing.status, 404);
  assert.doesNotMatch(missing.body, /<html/i);

  const head = await H.http(`${container.url}/`, { method: "HEAD" });
  assert.equal(head.status, 200);
  const post = await H.http(`${container.url}/`, { method: "POST" });
  assert.equal(post.status, 405);

  // Graceful shutdown: the server drains and exits 0 on SIGTERM, well inside the grace period.
  const started = Date.now();
  H.dockerMust("docker stop", "stop", "-t", "20", container.id);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `container took ${elapsed}ms to stop; SIGTERM was probably ignored`);
  assert.equal(H.inspect(container.id, "{{.State.ExitCode}}"), "0", "container should exit cleanly on SIGTERM");
  assert.match(H.logs(container.id), /shutdown signal received/);
});
