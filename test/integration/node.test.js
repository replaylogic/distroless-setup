/* Docker-backed integration tests for the Node.js stack.
 *
 * These build the image the CLI generated, run it, and probe it from outside the
 * container. Nothing here asserts on Dockerfile text for its own sake: text
 * assertions exist only where the generated line is the thing under test.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const H = require("./helpers");

const available = H.dockerAvailable();
const skip = available ? false : "no Linux Docker daemon reachable";

test("node/express-ts: builds, runs non-root, prunes dev deps, shuts down on SIGTERM", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("node-express-ts");
  const tag = "distroless-setup-it/express-ts:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("node", dir);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  // The entry point and prune step are the generator decisions this fixture exists to pin.
  assert.match(dockerfile, /^CMD \["dist\/main\.js"\]$/m, "should run the compiled entry with plain node");
  assert.match(dockerfile, /^RUN npm prune --omit=dev$/m, "should drop dev dependencies before the runtime copy");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  container = H.startContainer(tag, { port: 3000, env: { GREETING: "from-the-environment" } });
  const res = await H.waitForHttp(container, "/health");

  const body = H.assertReportedIdentity(res.body);
  assert.equal(body.greeting, "from-the-environment", "the container should read GREETING at runtime");
  assert.equal(body.devDependencyPresent, false, "typescript is a devDependency and must not survive the prune");
  assert.equal(body.nodeEnv, "production", "NODE_ENV=production should be set by the generated image");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  const root = await H.http(`${container.url}/`);
  assert.equal(root.status, 200);
  assert.match(root.body, /fixture-express-ts/);

  // Graceful shutdown: Node is PID 1 and must exit on SIGTERM well inside the grace period.
  const started = Date.now();
  H.dockerMust("docker stop", "stop", "-t", "20", container.id);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `container took ${elapsed}ms to stop; SIGTERM was probably ignored`);
  assert.equal(H.inspect(container.id, "{{.State.ExitCode}}"), "0", "container should exit cleanly on SIGTERM");
});

test("node/express-ts: runs with a read-only root filesystem and only /tmp writable", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("node-express-ts");
  const tag = "distroless-setup-it/express-ts-ro:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("node", dir);
  H.buildImage(dir, tag);

  // Run exactly the read-only command the generated report tells the user to run, so a
  // mismatch between the documented mounts and what the image needs fails the test.
  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, ["/tmp"], "a plain Node service should document /tmp and nothing else");

  container = H.startContainer(tag, { port: 3000, args: ro.args });
  const res = await H.waitForHttp(container, "/health");
  H.assertReportedIdentity(res.body);
});

test("node/next: standalone output builds, serves pages, assets and the API route", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("node-next");
  const tag = "distroless-setup-it/next:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("node", dir);

  // The CLI must have edited next.config.mjs rather than falling back to `next start`.
  const nextConfig = H.readGenerated(dir, "next.config.mjs");
  assert.match(nextConfig, /output:\s*["']standalone["']/, "output: 'standalone' should have been added");
  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /^CMD \["server\.js"\]$/m, "standalone mode runs the traced server.js");
  assert.match(dockerfile, /\/app\/\.next\/standalone/, "standalone output should be copied into the runtime image");
  assert.match(dockerfile, /\/app\/public \.\/public/, "public/ should be copied into the runtime image");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  // Next.js keeps its cache under .next/cache; the report tells users to mount it when
  // the root filesystem is read-only. Run under exactly the constraints it documents.
  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, ["/tmp", "/app/.next/cache"], "Next.js needs its cache path documented as writable");

  container = H.startContainer(tag, { port: 3000, env: { GREETING: "next-env" }, args: ro.args });

  const health = await H.waitForHttp(container, "/api/health");
  const body = H.assertReportedIdentity(health.body);
  assert.equal(body.greeting, "next-env");
  assert.equal(body.nodeEnv, "production");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  const page = await H.http(`${container.url}/`);
  assert.equal(page.status, 200);
  assert.match(page.body, /fixture-next home/, "the rendered page should come from the standalone server");

  const asset = await H.http(`${container.url}/ping.txt`);
  assert.equal(asset.status, 200, "files under public/ must be served");
  assert.match(asset.body, /public-asset-ok/);
});

test("dry run leaves the project untouched apart from the report", { skip: false, timeout: 300000 }, async (t) => {
  const dir = H.copyFixture("node-express-ts");
  t.after(() => H.cleanupDir(dir));

  const before = H.snapshot(dir);
  H.runCli("node", dir, ["--dry-run"]);
  const after = H.snapshot(dir);

  assert.ok(!fs.existsSync(path.join(dir, "Dockerfile")), "--dry-run must not write a Dockerfile");
  assert.ok(!fs.existsSync(path.join(dir, ".dockerignore")), "--dry-run must not write a .dockerignore");
  assert.ok(!fs.existsSync(path.join(dir, ".distroless-backup")), "--dry-run must not create backups");

  const added = [...after.keys()].filter((k) => !before.has(k));
  assert.deepEqual(added, ["DISTROLESS-MIGRATION.md"], "the report is the only file a dry run may write");
  for (const [k, v] of before) assert.equal(after.get(k), v, `--dry-run modified ${k}`);
  assert.match(after.get("DISTROLESS-MIGRATION.md"), /DRY RUN/);
});

test("applying the plan backs up every file it overwrites", { skip: false, timeout: 300000 }, async (t) => {
  const dir = H.copyFixture("node-express-ts");
  t.after(() => H.cleanupDir(dir));

  const original = "# hand-written Dockerfile\nFROM node:20\n";
  fs.writeFileSync(path.join(dir, "Dockerfile"), original);
  fs.writeFileSync(path.join(dir, ".dockerignore"), "node_modules\n");

  H.runCli("node", dir);

  const backupRoot = path.join(dir, ".distroless-backup");
  assert.ok(fs.existsSync(backupRoot), "a backup directory should exist after an apply");
  const stamps = fs.readdirSync(backupRoot);
  assert.equal(stamps.length, 1, "one timestamped backup per run");
  const saved = path.join(backupRoot, stamps[0], "Dockerfile");
  assert.ok(fs.existsSync(saved), "the overwritten Dockerfile should be backed up");
  assert.equal(fs.readFileSync(saved, "utf8"), original, "the backup must hold the pre-run content");
  assert.notEqual(fs.readFileSync(path.join(dir, "Dockerfile"), "utf8"), original, "the Dockerfile should have been replaced");
});

test("re-running over its own output is safe and converges", { skip: false, timeout: 300000 }, async (t) => {
  const dir = H.copyFixture("node-express-ts");
  t.after(() => H.cleanupDir(dir));

  const backupRoot = path.join(dir, ".distroless-backup");

  H.runCli("node", dir);
  const first = fs.readFileSync(path.join(dir, "Dockerfile"), "utf8");
  // Nothing existed to replace on a pristine project, so there is nothing to back up.
  assert.ok(!fs.existsSync(backupRoot), "a first run over a clean project should create no backup");

  H.runCli("node", dir);
  const second = fs.readFileSync(path.join(dir, "Dockerfile"), "utf8");

  assert.equal(second, first, "a second run should regenerate an identical Dockerfile");
  // The second run replaces the first run's files, so now exactly one backup exists.
  assert.deepEqual(fs.readdirSync(backupRoot).length, 1, "the second run backs up what it replaces");

  H.runCli("node", dir);
  assert.equal(fs.readFileSync(path.join(dir, "Dockerfile"), "utf8"), first, "output stays stable across runs");
  assert.equal(fs.readdirSync(backupRoot).length, 2,
    "a third run must not reuse the second run's backup directory, even within the same second");
});

test("node/express-ts with pnpm: Corepack install, prod prune and symlinked node_modules survive", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("node-express-ts-pnpm");
  const tag = "distroless-setup-it/express-ts-pnpm:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  const out = H.runCli("node", dir);
  assert.match(out, /package manager: pnpm \(lockfile pnpm-lock\.yaml\)/);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  // This fixture exists for the package-manager path, not for Express again.
  assert.match(dockerfile, /^RUN corepack enable$/m, "a non-npm package manager needs Corepack in the build stage");
  assert.match(dockerfile, /^COPY package\.json pnpm-lock\.yaml \.\/$/m);
  assert.match(dockerfile, /^RUN pnpm install --frozen-lockfile$/m);
  assert.match(dockerfile, /^RUN pnpm prune --prod$/m);
  // Word-anchored: "pnpm install" contains the substring "npm install", so a naive
  // pattern here would match the correct output.
  assert.doesNotMatch(dockerfile, /(?:^|\s)npm\s+(?:ci|install|prune)\b/m,
    "npm's own commands must not leak into a pnpm project");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, ["/tmp"]);
  container = H.startContainer(tag, { port: 3000, env: { GREETING: "pnpm-env" }, args: ro.args });

  const res = await H.waitForHttp(container, "/health");
  const body = H.assertReportedIdentity(res.body);
  assert.equal(body.greeting, "pnpm-env");
  // pnpm lays node_modules out as symlinks into a .pnpm store. If that structure did not
  // survive `COPY --from=build`, express would not resolve and this request would not exist.
  assert.equal(body.devDependencyPresent, false, "pnpm prune --prod must drop devDependencies");
  assert.equal(body.nodeEnv, "production");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  const root = await H.http(`${container.url}/`);
  assert.equal(root.status, 200);
  assert.match(root.body, /fixture-express-ts-pnpm/);

  const started = Date.now();
  H.dockerMust("docker stop", "stop", "-t", "20", container.id);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 15000, `container took ${elapsed}ms to stop; SIGTERM was probably ignored`);
  assert.equal(H.inspect(container.id, "{{.State.ExitCode}}"), "0", "container should exit cleanly on SIGTERM");
});
