/* Docker-backed integration tests for the Angular stack.
 *
 * The Angular path is the one with the most generated machinery: a Go static
 * server compiled from generated source, a generated config service wired into
 * the app, AST-rewritten environment reads, and a runtime config JSON rendered
 * from environment variables. All of it has to survive a real `ng build` and a
 * real distroless/static runtime.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const H = require("./helpers");

const available = H.dockerAvailable();
const skip = available ? false : "no Linux Docker daemon reachable";

/** First hashed asset referenced by the served index.html. */
function firstHashedAsset(html) {
  const m = /(?:src|href)="((?:[\w./-]*\/)?[\w.-]+-[A-Z0-9]{8}\.(?:js|css))"/.exec(html);
  assert.ok(m, `no hashed asset found in the served index.html:\n${html.slice(0, 600)}`);
  return "/" + m[1].replace(/^\//, "");
}

test("angular: generated Go server serves the SPA, its assets and /healthz", { skip, timeout: 2400000 }, async (t) => {
  const dir = H.copyFixture("angular-spa");
  const tag = "distroless-setup-it/angular-spa:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("angular", dir);

  // The Angular-side codegen has to compile under the real Angular compiler, so
  // assert it was produced at all before spending a build on it.
  const service = H.readGenerated(dir, "src/app/core/config/_runtime-config.service.ts");
  assert.match(service, /export function provideRuntimeConfig\(\)/);
  const appConfig = H.readGenerated(dir, "src/app/app.config.ts");
  assert.match(appConfig, /providers: \[provideRuntimeConfig\(\)\]/, "the provider should be wired into the bootstrap config");
  const api = H.readGenerated(dir, "src/app/api.service.ts");
  assert.match(api, /readonly base = runtimeConfig\(\)\.apiBaseUrl;/, "an instance-field read should be rewritten");
  assert.match(api, /return environment\.production;/, "a build-time key must be left alone");
  assert.match(api, /return runtimeConfig\(\)\.authClientId;/, "a nested key should be read through its flattened name");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  // The Go server renders the config and pre-compresses assets in memory, so the report
  // claims no writable mount is needed at all. Run it under exactly that claim.
  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, [], "the Angular runtime should need no writable paths");

  container = H.startContainer(tag, { port: 8080, args: ro.args });
  const index = await H.waitForHttp(container, "/");

  assert.match(index.body, /<app-root>/, "index.html should be served from the build output");
  assert.equal(index.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.equal(index.headers.get("x-frame-options"), "SAMEORIGIN", "nginx security headers should be carried over");
  assert.equal(index.headers.get("x-content-type-options"), "nosniff");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  const health = await H.http(`${container.url}/healthz`);
  assert.equal(health.status, 200);
  assert.match(health.body, /ok/);

  // SPA fallback: a client-side route must return index.html, not a 404.
  const deep = await H.http(`${container.url}/some/deep/route`);
  assert.equal(deep.status, 200, "unknown routes should fall back to index.html");
  assert.equal(deep.body, index.body);

  // A hashed asset that does not exist must 404 rather than silently fall back,
  // otherwise a stale client would execute HTML as JavaScript.
  const missing = await H.http(`${container.url}/main-DEADBEEF.js`);
  assert.equal(missing.status, 404);

  const assetPath = firstHashedAsset(index.body);
  const asset = await H.http(container.url + assetPath);
  assert.equal(asset.status, 200, `hashed asset ${assetPath} should be served`);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const pub = await H.http(`${container.url}/ping.txt`);
  assert.equal(pub.status, 200, "files from the Angular public/ folder should be served");
  assert.match(pub.body, /public-asset-ok/);

  const gz = await H.http(`${container.url}/`, { headers: { "Accept-Encoding": "gzip" } });
  assert.equal(gz.headers.get("content-encoding"), "gzip", "index.html should be served pre-compressed");
});

test("angular: one image, config changed by environment variables without a rebuild", { skip, timeout: 2400000 }, async (t) => {
  const dir = H.copyFixture("angular-spa");
  const tag = "distroless-setup-it/angular-runtime-config:test";
  const containers = [];
  t.after(() => {
    for (const c of containers) H.stopContainer(c.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("angular", dir);

  // The fixture's production configuration replaces environment.ts with
  // environment.prod.ts, so the CLI generates a per-configuration file and copies
  // it over the bundled default at build time.
  const prodConfig = JSON.parse(H.readGenerated(dir, "runtime-config/config.production.json"));
  assert.deepEqual(prodConfig, {
    apiBaseUrl: "https://api.prod.example.com",
    featureFlag: true,
    retries: 5,
    authClientId: "prod-client",
    authScope: "openid profile offline_access",
  });
  const baseConfig = JSON.parse(H.readGenerated(dir, "public/config.json"));
  assert.equal(baseConfig.apiBaseUrl, "https://api.dev.example.com", "the bundled default comes from environment.ts");

  H.buildImage(dir, tag);

  // 1. No override: the build-time file wins.
  const plain = H.startContainer(tag, { port: 8080, args: ["--read-only"] });
  containers.push(plain);
  const before = await H.waitForHttp(plain, "/config.json");
  assert.deepEqual(JSON.parse(before.body), prodConfig,
    "without USE_RUNTIME_CONFIG the build-time config must be served unchanged");
  H.stopContainer(plain.id);

  // 2. Same image, environment variables set: only those keys change.
  const overridden = H.startContainer(tag, {
    port: 8080,
    args: ["--read-only"],
    env: {
      USE_RUNTIME_CONFIG: "true",
      API_BASE_URL: "https://api.override.example.com",
      RETRIES: "9",
    },
  });
  containers.push(overridden);
  const after = await H.waitForHttp(overridden, "/config.json");
  const cfg = JSON.parse(after.body);

  assert.equal(cfg.apiBaseUrl, "https://api.override.example.com", "a set env var should override its key");
  assert.equal(cfg.retries, 9, "a JSON-typed key should stay a number, not become a string");
  assert.equal(cfg.authClientId, "prod-client", "keys with no env var set must keep their build-time value");
  assert.equal(cfg.featureFlag, true);
  assert.equal(after.headers.get("cache-control"), "no-cache, no-store, must-revalidate",
    "the runtime config must never be cached");
});

test("angular: removes the nginx config and entrypoint it replaces, after backing them up", { skip: false, timeout: 600000 }, async (t) => {
  const dir = H.copyFixture("angular-spa");
  t.after(() => H.cleanupDir(dir));

  const nginxConf = path.join(dir, "nginx.conf");
  const entrypoint = path.join(dir, "docker-entrypoint.sh");
  fs.writeFileSync(nginxConf, [
    "server {",
    "  listen 8080;",
    "  add_header X-Frame-Options DENY;",
    "  add_header Permissions-Policy \"geolocation=()\";",
    "  location / { try_files $uri $uri/ /index.html; }",
    "}",
  ].join("\n"));
  fs.writeFileSync(entrypoint, "#!/bin/sh\nexec nginx -g 'daemon off;'\n");

  H.runCli("angular", dir);

  assert.ok(!fs.existsSync(nginxConf), "the nginx config should be removed");
  assert.ok(!fs.existsSync(entrypoint), "the nginx entrypoint script should be removed");

  const stamp = fs.readdirSync(path.join(dir, ".distroless-backup"))[0];
  assert.ok(fs.existsSync(path.join(dir, ".distroless-backup", stamp, "nginx.conf")),
    "removed files must be backed up first");

  // Headers declared in nginx.conf are carried into the generated Go server.
  const generated = H.readGenerated(dir, "server/zz_generated_config.go");
  assert.match(generated, /\{"X-Frame-Options", "DENY"\}/, "an nginx header value should win over the default");
  assert.match(generated, /\{"Permissions-Policy", "geolocation=\(\)"\}/, "extra nginx headers should be carried over");
});
