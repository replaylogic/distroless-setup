/* Docker-backed integration tests for the Python stack.
 *
 * All three fixtures share the same generated layout (a venv built against the
 * runtime's own interpreter) but exercise materially different runtime paths:
 * uvicorn standalone, Gunicorn + the Uvicorn ASGI worker, and Gunicorn's sync
 * WSGI worker.
 */
const test = require("node:test");
const assert = require("node:assert/strict");

const H = require("./helpers");

const available = H.dockerAvailable();
const skip = available ? false : "no Linux Docker daemon reachable";

test("python/fastapi + uvicorn: venv runs on the distroless interpreter", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("python-fastapi-uvicorn");
  const tag = "distroless-setup-it/fastapi-uvicorn:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("python", dir);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /^ENTRYPOINT \["\/venv\/bin\/python3", "-m", "uvicorn", "main:app"\]$/m,
    "the discovered ASGI target should be started by uvicorn");
  // The venv is built against /usr/bin/python so it resolves in the runtime image.
  assert.match(dockerfile, /ln -s \/usr\/local\/bin\/python \/usr\/bin\/python/);

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, ["/tmp"], "the report should document /tmp as the only writable path");
  container = H.startContainer(tag, { port: 8000, env: { GREETING: "python-env" }, args: ro.args });

  const res = await H.waitForHttp(container, "/health");
  const body = H.assertReportedIdentity(res.body);
  assert.equal(body.greeting, "python-env");
  assert.equal(body.server, "uvicorn");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);
});

test("python/fastapi + gunicorn: uses the supported uvicorn-worker class", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("python-fastapi-gunicorn");
  const tag = "distroless-setup-it/fastapi-gunicorn:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("python", dir);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /"-k", "uvicorn_worker\.UvicornWorker"/,
    "gunicorn should use the standalone uvicorn-worker package");
  assert.doesNotMatch(dockerfile, /uvicorn\.workers/,
    "the deprecated uvicorn.workers module must not appear in generated output");
  assert.match(dockerfile, /"--worker-tmp-dir", "\/dev\/shm"/,
    "the worker heartbeat must live on a writable tmpfs for read-only roots");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  // Gunicorn keeps its worker heartbeat in /dev/shm, which Docker mounts writable, so the
  // report documents only /tmp. If that were wrong, this run would not come up.
  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, ["/tmp"]);
  container = H.startContainer(tag, { port: 8000, env: { GREETING: "gunicorn-env" }, args: ro.args });

  const res = await H.waitForHttp(container, "/health");
  const body = H.assertReportedIdentity(res.body);
  assert.equal(body.greeting, "gunicorn-env");
  assert.equal(body.workerModule, "uvicorn_worker",
    "the running worker must come from uvicorn_worker, not uvicorn.workers");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  assert.match(H.logs(container.id), /Using worker: uvicorn_worker\.UvicornWorker/);
});

test("python/flask + gunicorn: the WSGI path serves through the published port", { skip, timeout: 1800000 }, async (t) => {
  const dir = H.copyFixture("python-flask-gunicorn");
  const tag = "distroless-setup-it/flask-gunicorn:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  H.runCli("python", dir);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /"-m", "gunicorn"/);
  assert.doesNotMatch(dockerfile, /"-k",/, "a WSGI app should use gunicorn's default sync worker");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  container = H.startContainer(tag, { port: 8000, args: H.readOnlyArgsFromReport(dir).args });

  const res = await H.waitForHttp(container, "/health");
  const body = H.assertReportedIdentity(res.body);
  assert.equal(body.server, "gunicorn-wsgi");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  const root = await H.http(`${container.url}/`);
  assert.equal(root.status, 200);
  assert.match(root.body, /fixture-flask-gunicorn/);
});

test("python: a missing worker package is reported rather than silently installed-and-forgotten", { skip: false, timeout: 300000 }, async (t) => {
  const dir = H.copyFixture("python-fastapi-gunicorn");
  t.after(() => H.cleanupDir(dir));

  // Drop uvicorn-worker from the dependency file, keeping gunicorn + uvicorn so the
  // default server choice stays "gunicorn + uvicorn workers".
  const fs = require("node:fs");
  const path = require("node:path");
  const req = path.join(dir, "requirements.txt");
  fs.writeFileSync(req, fs.readFileSync(req, "utf8").split(/\r?\n/).filter((l) => !/uvicorn-worker/.test(l)).join("\n"));

  const out = H.runCli("python", dir);
  assert.match(out, /uvicorn-worker is not in your dependency files/);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  assert.match(dockerfile, /pip install .*uvicorn-worker/, "the image should install the missing worker package");
  assert.match(dockerfile, /"-k", "uvicorn_worker\.UvicornWorker"/);
  assert.match(H.readGenerated(dir, "DISTROLESS-MIGRATION.md"), /Add .*uvicorn-worker.* to your dependency file with a pinned version/,
    "the report must tell the user to pin it in their own dependency file");
});

test("python/django + uv: uv sync, collectstatic and WhiteNoise all work in the image", { skip, timeout: 2400000 }, async (t) => {
  const dir = H.copyFixture("python-django-uv");
  const tag = "distroless-setup-it/django-uv:test";
  let container = null;
  t.after(() => {
    H.stopContainer(container?.id);
    H.removeImage(tag);
    H.cleanupDir(dir);
  });

  const out = H.runCli("python", dir);

  // Detection: Django, uv, the WSGI application from manage.py, and a health route.
  assert.match(out, /Python \(Django\)/);
  assert.match(out, /gunicorn on Python 3\.13 \(uv\)/, "uv should be the detected dependency manager");
  assert.match(out, /app: config\.wsgi:application \(manage\.py settings module\)/);
  assert.match(out, /health endpoint found: \/health\//);

  const dockerfile = H.readGenerated(dir, "Dockerfile");
  // The uv install path is what this fixture exists for: a real two-step frozen sync.
  assert.match(dockerfile, /^RUN uv sync --frozen --no-dev --no-install-project$/m);
  assert.match(dockerfile, /^RUN uv sync --frozen --no-dev --no-editable$/m);
  assert.match(dockerfile, /UV_PYTHON_DOWNLOADS=never/, "uv must not download its own interpreter");
  // Django specifics.
  assert.match(dockerfile, /^RUN \/venv\/bin\/python manage\.py collectstatic --noinput$/m);
  assert.match(dockerfile, /DJANGO_SETTINGS_MODULE=config\.settings/);
  assert.match(dockerfile, /^ENTRYPOINT \["\/venv\/bin\/python3", "-m", "gunicorn", "--worker-tmp-dir", "\/dev\/shm", "--access-logfile", "-", "config\.wsgi:application"\]$/m);
  assert.doesNotMatch(dockerfile, /"-k",/, "a WSGI app should use gunicorn's default sync worker");

  const report = H.readGenerated(dir, "DISTROLESS-MIGRATION.md");
  assert.match(report, /Run `migrate` outside the app container, e\.g\. a Kubernetes Job or init container/,
    "the report must keep migrations out of the application startup path");
  // This fixture ships WhiteNoise, so the report must NOT tell the user to add it.
  assert.doesNotMatch(report, /Add `whitenoise` to the dependencies/,
    "WhiteNoise is already a dependency; the report should not ask for it");

  H.buildImage(dir, tag);
  H.assertNoShellOrPackageManager(tag);

  const ro = H.readOnlyArgsFromReport(dir);
  assert.deepEqual(ro.mounts, ["/tmp"], "no database and no bytecode writes: /tmp is the only writable path");
  container = H.startContainer(tag, { port: 8000, env: { GREETING: "django-env" }, args: ro.args });

  const res = await H.waitForHttp(container, "/health/");
  const body = H.assertReportedIdentity(res.body);
  assert.equal(body.greeting, "django-env");
  assert.equal(body.framework, "django");
  assert.equal(body.settingsModule, "config.settings", "DJANGO_SETTINGS_MODULE should come from the generated ENV");

  H.assertNonRoot(container, tag);
  await H.waitForHealthy(container);

  // A hashed URL can only be resolved from the manifest collectstatic wrote at build time.
  assert.match(body.staticUrl, /^\/static\/fixture\.[0-9a-f]{12}\.css$/,
    `collectstatic did not produce a hashed asset (got ${body.staticUrl})`);

  // ...and WhiteNoise must actually serve it out of the read-only image.
  const asset = await H.http(container.url + body.staticUrl);
  assert.equal(asset.status, 200, "the collected static file should be served");
  assert.match(asset.body, /collectstatic-ok/);
  assert.match(asset.headers.get("cache-control") ?? "", /immutable/, "hashed static files should be cached immutably");

  const missing = await H.http(`${container.url}/static/not-collected.css`);
  assert.equal(missing.status, 404);

  const root = await H.http(`${container.url}/`);
  assert.equal(root.status, 200);
  assert.match(root.body, /fixture-django-uv/);
});

test("python/django: the report asks for a static-file strategy when WhiteNoise is absent", { skip: false, timeout: 300000 }, async (t) => {
  const dir = H.copyFixture("python-django-uv");
  t.after(() => H.cleanupDir(dir));

  // The companion of the assertion above: with nothing to serve static files, the
  // report must say so rather than leaving collectstatic output unreachable.
  const fs = require("node:fs");
  const path = require("node:path");
  const pyproject = path.join(dir, "pyproject.toml");
  fs.writeFileSync(pyproject, fs.readFileSync(pyproject, "utf8").split(/\r?\n/).filter((l) => !/whitenoise/.test(l)).join("\n"));

  H.runCli("python", dir);

  const report = H.readGenerated(dir, "DISTROLESS-MIGRATION.md");
  assert.match(report, /Django doesn't serve static files in production\. Add `whitenoise`/,
    "without WhiteNoise the report must name a static-serving strategy");
  assert.match(H.readGenerated(dir, "Dockerfile"), /collectstatic --noinput/,
    "collectstatic should still run; only the serving strategy is missing");
});
