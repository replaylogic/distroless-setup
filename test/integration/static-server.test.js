/* Behaviour tests for the Go static SPA server shared by the Angular and React stacks.
 *
 * The server source is generated, so its tests can't live beside it. This copies the
 * generated main.go, go.mod and a zz_generated_config.go into a temp module together with
 * test/static-server/server_test.go and runs `go test` there: with a local Go toolchain if
 * there is one, otherwise inside the same golang image the generated Dockerfiles use.
 */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const H = require("./helpers");
const spa = require("../../dist/stacks/shared/static-spa");

const localGo = H.run("go", ["version"], { timeout: 60000 }).status === 0;
const skip = localGo || H.dockerAvailable() ? false : "neither a Go toolchain nor a Linux Docker daemon is available";

test("static server: caching, SPA fallback, 404s, methods, gzip, headers, runtime config", { skip, timeout: 900000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dls-go-"));
  try {
    const rc = { enabled: true, url: "/config.json", fields: [["apiUrl", "API_URL", false], ["retries", "RETRIES", true]], override: null };
    fs.writeFileSync(path.join(dir, "main.go"), spa.MAIN_GO);
    fs.writeFileSync(path.join(dir, "go.mod"), spa.GO_MOD);
    fs.writeFileSync(path.join(dir, "zz_generated_config.go"), spa.renderGeneratedGo(rc, spa.DEFAULT_HEADERS));
    fs.copyFileSync(path.join(H.REPO, "test", "static-server", "server_test.go"), path.join(dir, "server_test.go"));

    const r = localGo
      ? H.run("go", ["test", "-count=1", "./..."], { cwd: dir, env: { ...process.env, CGO_ENABLED: "0" } })
      : H.docker("run", "--rm", "-e", "CGO_ENABLED=0", "-v", `${dir}:/src`, "-w", "/src", spa.GO_IMAGE, "go", "test", "-count=1", "./...");
    assert.equal(r.status, 0, `go test failed\n${r.stdout}\n${r.stderr}`);
  } finally {
    H.cleanupDir(dir);
  }
});
