/* Python services (FastAPI, Flask, Django, plain scripts) on distroless/python3. */
import * as path from "path";
import { askImage, parseExistingDockerfile, reviewReferences } from "../../core/docker";
import { exists, isDir, readText, rel, validPort, walkFiles } from "../../core/files";
import { ActionItem, Ctx, MARKER, Stack, StackResult, VERSION, mdTable } from "../../core/report";
import { G, fail, info, panel, s, section, warn } from "../../core/ui";

const RUNTIME_PY: [number, number] = [3, 13]; // gcr.io/distroless/python3-debian13
const RUNTIME_IMAGE = "gcr.io/distroless/python3-debian13:nonroot";
const BUILD_IMAGE = "python:3.13-slim-trixie";

type Pm = "uv" | "poetry" | "pipenv" | "pip" | "pip-project";
type Fw = "django" | "fastapi" | "flask" | "starlette" | "generic";
const FW_LABEL: Record<Fw, string> = { django: "Django", fastapi: "FastAPI", flask: "Flask", starlette: "Starlette", generic: "Python" };

const PROJECT_FILES = ["pyproject.toml", "requirements.txt", "Pipfile", "setup.py", "setup.cfg", "uv.lock", "poetry.lock", "manage.py"];

function reqFiles(repo: string): string[] {
  const top = [...walkFiles(repo, (f) => path.dirname(f) === repo && /^requirements.*\.(txt|in)$/i.test(path.basename(f)))];
  const dir = path.join(repo, "requirements");
  return [...top, ...(isDir(dir) ? [...walkFiles(dir, (f) => /\.(txt|in)$/.test(f))] : [])];
}

function depsText(repo: string): string {
  return [...["pyproject.toml", "Pipfile", "setup.py", "setup.cfg"].map((f) => path.join(repo, f)), ...reqFiles(repo)]
    .map(readText).join("\n").toLowerCase();
}

export const has = (text: string, name: string) =>
  new RegExp(`(^|[\\s"'\\[,(])${name.replace(/[.*+?^${}()|[\]\\-]/g, (c) => (c === "-" ? "[-_]" : "\\" + c))}(\\[[^\\]]*\\])?\\s*([<>=~!;,"'\\s)]|$)`, "im").test(text);

function detectPm(repo: string): Pm | null {
  if (exists(path.join(repo, "uv.lock"))) return "uv";
  const pyproject = readText(path.join(repo, "pyproject.toml"));
  if (exists(path.join(repo, "poetry.lock")) || /^\[tool\.poetry\]/m.test(pyproject)) return "poetry";
  if (exists(path.join(repo, "Pipfile"))) return "pipenv";
  if (reqFiles(repo).length) return "pip";
  if (/^\[project\]/m.test(pyproject) || exists(path.join(repo, "setup.py"))) return "pip-project";
  return null;
}

function pyFiles(repo: string): string[] {
  return [...walkFiles(repo, (f) => f.endsWith(".py") && !/[\\/](tests?|migrations)[\\/]/.test(f) && !/(^|[\\/])test_[^\\/]*\.py$/.test(f))].slice(0, 5000);
}

// ---- Python version ---------------------------------------------------------------------
function pythonSpecs(repo: string): { spec: string; from: string }[] {
  const out: { spec: string; from: string }[] = [];
  const pv = readText(path.join(repo, ".python-version")).trim().split(/\s+/)[0];
  if (pv) out.push({ spec: `==${pv.replace(/^(\d+\.\d+).*/, "$1")}.*`, from: ".python-version" });
  const py = readText(path.join(repo, "pyproject.toml"));
  const rp = /^\s*requires-python\s*=\s*["']([^"']+)["']/m.exec(py);
  if (rp) out.push({ spec: rp[1], from: "requires-python" });
  const poetry = /\[tool\.poetry\.dependencies\][^[]*?^\s*python\s*=\s*["']([^"']+)["']/ms.exec(py);
  if (poetry) out.push({ spec: poetry[1], from: "tool.poetry python" });
  const rt = /python-(\d+\.\d+)/.exec(readText(path.join(repo, "runtime.txt")));
  if (rt) out.push({ spec: `==${rt[1]}.*`, from: "runtime.txt" });
  const pf = /python_version\s*=\s*["'](\d+\.\d+)["']/.exec(readText(path.join(repo, "Pipfile")));
  if (pf) out.push({ spec: `==${pf[1]}.*`, from: "Pipfile" });
  return out;
}

/** Does a PEP 440 / Poetry version spec accept Python major.minor? (good enough for version gates) */
export function specAllows(spec: string, [maj, min]: [number, number]): boolean {
  const v = maj * 100 + min;
  const num = (x: string) => { const [a, b = "0"] = x.split("."); return +a * 100 + +b; };
  for (const raw of spec.split(/[,|]/).map((c) => c.trim()).filter(Boolean)) {
    const m = /^(\^|~=|~|==|!=|>=|<=|>|<)?\s*v?(\d+(?:\.\d+)?)(?:\.[\d*]+)?(\.\*)?$/.exec(raw);
    if (!m) continue;
    const [, op = "==", ver, star] = m;
    const n = num(ver);
    const hasMinor = ver.includes(".");
    switch (op) {
      case ">=": if (v < n) return false; break;
      case ">": if (hasMinor ? v <= n : v < n + 100) return false; break;
      case "<=": if (v > n) return false; break;
      case "<": if (v >= n) return false; break;
      case "!=": if (hasMinor && v === n) return false; break;
      case "^": if (v < n || v >= Math.floor(n / 100) * 100 + 100) return false; break;
      case "~": case "~=": if (v < n || (hasMinor && op === "~" && v !== n) || (op === "~=" && Math.floor(v / 100) !== Math.floor(n / 100))) return false; break;
      case "==": if (hasMinor ? v !== n : Math.floor(v / 100) !== n / 100) return false; if (!star && !hasMinor) return false; break;
    }
  }
  return true;
}

// ---- app discovery ----------------------------------------------------------------------
function moduleOf(repo: string, file: string): { module: string; srcRoot: string | null } {
  let r = rel(repo, file).replace(/\.py$/, "");
  let srcRoot: string | null = null;
  if (r.startsWith("src/")) { srcRoot = "src"; r = r.slice(4); }
  return { module: r.split("/").join(".").replace(/\.__init__$/, ""), srcRoot };
}

interface AppTarget { target: string; srcRoot: string | null; file: string | null; why: string }

export function findAsgiWsgi(repo: string, files: string[], fw: Fw): AppTarget | null {
  const prefer = (f: string) => (/(^|[\\/])(main|app|server|api|asgi|wsgi)\.py$/.test(f) ? 0 : 1) + rel(repo, f).split("/").length / 100;
  const sorted = [...files].sort((a, b) => prefer(a) - prefer(b));
  if (fw === "django") {
    const manage = readText(path.join(repo, "manage.py"));
    const m = /DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)\.settings(?:\.[\w]+)?['"]/.exec(manage);
    const proj = m?.[1];
    if (proj) {
      const wsgi = path.join(repo, ...proj.split("."), "wsgi.py");
      if (exists(wsgi)) return { target: `${proj}.wsgi:application`, srcRoot: null, file: wsgi, why: "manage.py settings module" };
    }
    const w = sorted.find((f) => path.basename(f) === "wsgi.py" && /get_wsgi_application/.test(readText(f)));
    if (w) { const { module, srcRoot } = moduleOf(repo, w); return { target: `${module}:application`, srcRoot, file: w, why: "wsgi.py" }; }
    return null;
  }
  const ctor = fw === "fastapi" ? "FastAPI" : fw === "flask" ? "Flask" : "Starlette";
  for (const f of sorted) {
    const t = readText(f);
    const m = new RegExp(`^(\\w+)\\s*(?::\\s*[\\w.]+\\s*)?=\\s*(?:\\w+\\.)?${ctor}\\(`, "m").exec(t);
    if (m) { const { module, srcRoot } = moduleOf(repo, f); return { target: `${module}:${m[1]}`, srcRoot, file: f, why: `${ctor}() in ${rel(repo, f)}` }; }
  }
  if (fw === "flask")
    for (const f of sorted) if (/^def\s+create_app\s*\(/m.test(readText(f))) {
      const { module, srcRoot } = moduleOf(repo, f);
      return { target: `${module}:create_app()`, srcRoot, file: f, why: `create_app() factory in ${rel(repo, f)}` };
    }
  return null;
}

function detectHealth(files: string[], fw: Fw): string | null {
  const names = "health|healthz|healthcheck|health-check|ready|readyz|readiness|live|livez|liveness|ping|status";
  const route = new RegExp(`(?:\\.(?:get|route|api_route|head)\\(|path\\(|re_path\\()\\s*r?['"](\\^?/?(?:api/)?(?:v\\d/)?(?:${names})/?\\$?)['"]`);
  for (const f of files) {
    const m = route.exec(readText(f));
    if (m) {
      let p = m[1].replace(/^\^/, "").replace(/\$$/, "");
      if (!p.startsWith("/")) p = "/" + p;
      return p;
    }
  }
  return null;
}

function envVars(files: string[]): string[] {
  const found = new Set<string>();
  const res = [
    /os\.environ\s*\[\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /os\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /os\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
    /\benv(?:\.\w+)?\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g, /\bconfig\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  ];
  for (const f of files) {
    const t = readText(f);
    for (const re of res) for (const m of t.matchAll(re)) found.add(m[1]);
  }
  return [...found].sort();
}

const SYSTEM_LIBS: Record<string, string> = {
  psycopg2: "links against libpq, which distroless doesn't ship. Use `psycopg2-binary` or `psycopg[binary]` (bundled libpq).",
  psycopg: "without the `[binary]` extra it needs libpq from the OS. Use `psycopg[binary]`.",
  mysqlclient: "links against libmysqlclient, which distroless doesn't ship. Use `PyMySQL` (pure Python) instead.",
  "python-ldap": "links against OpenLDAP libraries distroless doesn't ship.",
  pyodbc: "needs unixODBC and a driver, which distroless doesn't ship.",
  weasyprint: "needs pango/cairo, which distroless doesn't ship.",
  pycairo: "needs cairo, which distroless doesn't ship.",
  cairosvg: "needs cairo, which distroless doesn't ship.",
  "opencv-python": "needs libGL. Use `opencv-python-headless`.",
  gdal: "needs the GDAL system library.",
  "pdf2image": "shells out to poppler binaries, which distroless doesn't ship.",
  pytesseract: "shells out to the tesseract binary, which distroless doesn't ship.",
  "python-magic": "needs libmagic, which distroless doesn't ship. Use `puremagic`.",
};

function shellUsage(repo: string, files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files)
    readText(f).split(/\r?\n/).forEach((l, i) => {
      if (/shell\s*=\s*True|\bos\.system\(|\bos\.popen\(|subprocess\.\w+\(\s*\[?\s*['"](?:sh|bash|curl|wget|git|ffmpeg|convert)\b/.test(l))
        hits.push(`${rel(repo, f)}:${i + 1}: ${l.trim().slice(0, 80)}`);
    });
  return hits;
}

// ---- Dockerfile ------------------------------------------------------------------------
interface Build {
  pm: Pm; buildImage: string; compiler: boolean; reqFile: string | null; reqNeedsSource: boolean; extraPkgs: string[];
  image: string; port: string; entry: string[]; env: [string, string][]; health: string | null; collectstatic: string | null;
}

function renderDockerfile(b: Build): string {
  const L = [
    `# ${MARKER} v${VERSION}. Re-run \`npx distroless-setup python\` to regenerate.`,
    "",
    "# ---- Stage 1: build a virtualenv with the same Python as the runtime (3.13, Debian trixie) ----",
    `FROM ${b.buildImage} AS build`,
    "# The runtime has python at /usr/bin/python; link it here so the venv points at a path that exists there.",
    "RUN " + [
      ...(b.compiler ? ["apt-get update", "apt-get install --no-install-suggests --no-install-recommends --yes gcc libc6-dev", "rm -rf /var/lib/apt/lists/*"] : []),
      "ln -s /usr/local/bin/python /usr/bin/python",
      "/usr/bin/python -m venv /venv",
      "/venv/bin/pip install --upgrade pip setuptools wheel",
    ].join(" \\\n && "),
    "ENV PIP_DISABLE_PIP_VERSION_CHECK=1 \\",
    "    PIP_NO_CACHE_DIR=1",
    "WORKDIR /app",
    "",
  ];
  switch (b.pm) {
    case "uv":
      L.push("RUN pip install uv",
        "ENV UV_PROJECT_ENVIRONMENT=/venv \\", "    UV_PYTHON=/venv/bin/python \\", "    UV_PYTHON_DOWNLOADS=never \\", "    UV_COMPILE_BYTECODE=1 \\", "    UV_LINK_MODE=copy",
        "# Dependencies first for layer caching, then the project itself",
        "COPY pyproject.toml uv.lock ./",
        "RUN uv sync --frozen --no-dev --no-install-project",
        "COPY . .",
        "RUN uv sync --frozen --no-dev --no-editable");
      break;
    case "poetry":
      L.push("RUN pip install poetry",
        "# Poetry installs into the active virtualenv named by VIRTUAL_ENV",
        "ENV VIRTUAL_ENV=/venv \\", "    POETRY_NO_INTERACTION=1",
        "COPY pyproject.toml poetry.lock ./",
        "RUN poetry install --only main --no-root",
        "COPY . .");
      break;
    case "pipenv":
      L.push("RUN pip install pipenv",
        "COPY Pipfile Pipfile.lock ./",
        "RUN pipenv requirements > /tmp/requirements.txt \\",
        " && /venv/bin/pip install -r /tmp/requirements.txt",
        "COPY . .");
      break;
    case "pip":
      if (b.reqNeedsSource) L.push("COPY . .", `RUN /venv/bin/pip install -r ${b.reqFile}`);
      else L.push("# Dependencies first for layer caching", `COPY ${b.reqFile!.includes("/") ? b.reqFile!.split("/")[0] + "/ " + b.reqFile!.split("/")[0] + "/" : b.reqFile + " ./"}`,
        `RUN /venv/bin/pip install -r ${b.reqFile}`, "COPY . .");
      break;
    case "pip-project":
      L.push("COPY . .", "RUN /venv/bin/pip install .");
      break;
  }
  if (b.extraPkgs.length) L.push(`# Added by distroless-setup; move it into your dependency file and pin it`, `RUN /venv/bin/pip install ${b.extraPkgs.join(" ")}`);
  if (b.collectstatic) L.push("", "# Static files are collected at build time (there is no shell at runtime)", `RUN ${b.collectstatic}`);
  L.push("", "",
    "# ---- Stage 2: runtime (distroless: no shell, no pip, non-root) ----",
    `FROM ${b.image}`,
    "WORKDIR /app",
    "# Group 0 ownership keeps files readable under OpenShift's arbitrary UIDs.",
    "COPY --from=build --chown=65532:0 /venv /venv",
    "COPY --from=build --chown=65532:0 /app /app",
    "",
    "ENV " + [["PYTHONDONTWRITEBYTECODE", "1"], ["PYTHONUNBUFFERED", "1"], ["PORT", b.port], ...b.env].map(([k, v]) => `${k}=${v}`).join(" \\\n    "),
    "",
    "USER 65532:0",
    `EXPOSE ${b.port}`, "");
  if (b.health) {
    // one line of output on failure (no traceback in `docker inspect`), non-zero exit
    const py = `import os, sys, urllib.request as u\ntry: u.urlopen('http://127.0.0.1:' + os.environ.get('PORT', '${b.port}') + '${b.health}', timeout=4)\nexcept Exception as e: sys.exit(f'unhealthy: {e}')`;
    L.push("# No curl/wget in distroless: Python's urllib probes the app (non-2xx/3xx exits non-zero).",
      "HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\",
      `  CMD ["/venv/bin/python3", "-c", ${JSON.stringify(py)}]`, "");
  }
  L.push(`ENTRYPOINT ${JSON.stringify(["/venv/bin/python3", ...b.entry]).replace(/","/g, '", "')}`, "");
  return L.join("\n");
}

// ---- stack ------------------------------------------------------------------------------
export const pythonStack: Stack = {
  id: "python",
  title: "Python",
  detect(repo) {
    const hits = PROJECT_FILES.filter((f) => exists(path.join(repo, f)));
    if (!hits.length && !reqFiles(repo).length) return null;
    const t = depsText(repo);
    const fw = exists(path.join(repo, "manage.py")) || has(t, "django") ? "Django" : has(t, "fastapi") ? "FastAPI" : has(t, "flask") ? "Flask" : null;
    return { score: fw ? 0.95 : 0.6, reason: [...hits.slice(0, 2), ...(fw ? [fw] : [])].join(", ") || "requirements files" };
  },

  async run(ctx: Ctx): Promise<StackResult> {
    const { repo, P, plan } = ctx;
    section("Scanning repo");
    const t = depsText(repo);
    const pm = detectPm(repo);
    if (!pm) fail("no pyproject.toml, requirements*.txt, Pipfile or setup.py found");
    const fw: Fw = exists(path.join(repo, "manage.py")) || has(t, "django") ? "django" : has(t, "fastapi") ? "fastapi" : has(t, "flask") ? "flask" : has(t, "starlette") ? "starlette" : "generic";
    const files = pyFiles(repo);
    const dockerfile = path.join(repo, "Dockerfile");
    const existing = parseExistingDockerfile(dockerfile);

    const specs = pythonSpecs(repo);
    const bad = specs.filter((x) => !specAllows(x.spec, RUNTIME_PY));
    panel("Before we start", [[null, [
      "The app will run on distroless Python: no shell, no pip, non-root. A build",
      "stage creates a virtualenv with the same Python, then only the venv and your",
      "code are copied across.",
      "",
      `Detected: ${s(FW_LABEL[fw], "cyan", "bold")}, ${s(pm === "pip-project" ? "pip (pyproject/setup.py)" : pm, "cyan")}` +
        (specs.length ? `, Python ${specs.map((x) => x.spec).join(" / ")}` : ""),
      `Runtime Python: ${s(RUNTIME_PY.join("."), "bold")} (the only version distroless publishes, on Debian 13)`,
    ]]], bad.length ? "yellow" : "cyan");
    for (const b of bad) warn(`${b.from} says ${b.spec}, but the distroless runtime is Python ${RUNTIME_PY.join(".")}. Test on ${RUNTIME_PY.join(".")} and update ${b.from}, or the install may fail.`);
    if (!(await P.confirm(`Continue with ${FW_LABEL[fw]} on Python ${RUNTIME_PY.join(".")}?`, bad.length === 0))) fail("aborted: no files changed");
    if (exists(dockerfile)) info("existing Dockerfile found (will be backed up and replaced)");

    // ---- build stage
    section("Build stage");
    const buildImage = await P.ask("Build-stage image (must be Python 3.13 on Debian trixie)", BUILD_IMAGE);
    if (!/3\.13/.test(buildImage)) warn("the build-stage Python must match the runtime's (3.13), or compiled packages and the venv break");
    let reqFile: string | null = null;
    let reqNeedsSource = false;
    if (pm === "pip") {
      const opts = reqFiles(repo).map((f) => rel(repo, f)).filter((f) => !/dev|test|lint|doc/i.test(f) || reqFiles(repo).length === 1);
      const all = reqFiles(repo).map((f) => rel(repo, f));
      const choices = opts.length ? opts : all;
      reqFile = choices.length > 1 ? choices[await P.choose("Which requirements file lists the production dependencies?", choices, Math.max(0, choices.indexOf("requirements.txt")))] : choices[0];
      const body = readText(path.join(repo, reqFile));
      reqNeedsSource = /^\s*(-e\s|\.\s*$|\.\[|-r\s|-c\s|--requirement|--constraint|file:)/m.test(body);
    }
    if (pm === "pipenv" && !exists(path.join(repo, "Pipfile.lock"))) warn("Pipfile.lock is missing; the build needs it for reproducible installs");
    const compiler = await P.confirm("Install a C compiler in the build stage (for packages without prebuilt wheels)?", true);

    // ---- how to run it
    section("How the app runs");
    const actions: ActionItem[] = [];
    const extraPkgs: string[] = [];
    const env: [string, string][] = [];
    let entry: string[];
    const found = fw === "generic" ? null : findAsgiWsgi(repo, files, fw);
    let serverLabel = "";
    const port = await P.ask("Container port (set as PORT)", existing.port && !validPort(existing.port) ? existing.port : "8000", validPort);
    if (fw !== "generic") {
      if (found) info(`app: ${s(found.target, "bold")} ${s("(" + found.why + ")", "gray")}`);
      else warn(`couldn't find the ${FW_LABEL[fw]} application object`);
      const target = await P.ask(fw === "django" ? "WSGI application (module:attr)" : "Application (module:attr)",
        found?.target ?? (fw === "django" ? "config.wsgi:application" : "app.main:app"), (v) => (/^[\w.]+:[\w.()]+$/.test(v) ? null : "use module.path:attribute"));
      const asgi = fw === "fastapi" || fw === "starlette";
      const servers = asgi ? ["uvicorn", "gunicorn + uvicorn workers", "hypercorn", "granian"] : ["gunicorn", "uvicorn (ASGI)", "waitress", "granian"];
      const installed = (n: string) => has(t, n);
      const defIdx = asgi ? (installed("uvicorn") ? (installed("gunicorn") ? 1 : 0) : installed("hypercorn") ? 2 : installed("granian") ? 3 : 0)
        : installed("gunicorn") ? 0 : installed("waitress") ? 2 : installed("granian") ? 3 : 0;
      const srv = servers[await P.choose("Production server", servers, defIdx)];
      serverLabel = srv;
      const need = srv.startsWith("gunicorn") ? ["gunicorn", ...(srv.includes("uvicorn") ? ["uvicorn"] : [])] : [srv.split(" ")[0]];
      const missing = need.filter((n) => !installed(n));
      if (missing.length) {
        warn(`${missing.join(", ")} ${missing.length > 1 ? "are" : "is"} not in your dependency files`);
        if (await P.confirm(`Install ${missing.join(", ")} in the image anyway (unpinned)?`, true)) extraPkgs.push(...missing);
        actions.push({ short: `Add ${missing.join(", ")} to your dependencies (pinned)`, md: `Add ${missing.map((m) => `\`${m}\``).join(", ")} to your dependency file with a pinned version. ${extraPkgs.length ? "The Dockerfile installs it unpinned for now; remove that line afterwards." : "The image won't start until it's installed."}` });
      }
      const appTarget = fw === "django" && srv.startsWith("uvicorn") ? target.replace(".wsgi:", ".asgi:") : target;
      if (srv === "uvicorn") { entry = ["-m", "uvicorn", appTarget]; env.push(["UVICORN_HOST", "0.0.0.0"], ["UVICORN_PORT", port]); }
      else if (srv.startsWith("gunicorn")) {
        // Gunicorn binds 0.0.0.0:$PORT by default. /dev/shm: its worker heartbeat needs a writable dir (read-only root).
        entry = ["-m", "gunicorn", ...(srv.includes("uvicorn") ? ["-k", "uvicorn.workers.UvicornWorker"] : []), "--worker-tmp-dir", "/dev/shm", "--access-logfile", "-", appTarget];
      } else if (srv === "uvicorn (ASGI)") { entry = ["-m", "uvicorn", appTarget]; env.push(["UVICORN_HOST", "0.0.0.0"], ["UVICORN_PORT", port]); }
      else if (srv === "hypercorn") entry = ["-m", "hypercorn", "--bind", `0.0.0.0:${port}`, appTarget];
      else if (srv === "waitress") entry = ["-m", "waitress", `--port=${port}`, appTarget];
      else entry = ["-m", "granian", "--interface", asgi ? "asgi" : "wsgi", "--host", "0.0.0.0", "--port", port, appTarget];
      if (found?.srcRoot) env.push(["PYTHONPATH", `/app/${found.srcRoot}`]);
      if (["hypercorn", "waitress", "granian"].includes(srv.split(" ")[0]))
        actions.push({ short: `${srv} gets a fixed port (${port}) in ENTRYPOINT`, md: `There is no shell to expand \`$PORT\`, so ${srv} is started with port ${port} in \`ENTRYPOINT\`. To change the port, re-run this tool or edit the Dockerfile.` });
    } else {
      const cands = ["main.py", "app.py", "server.py", "run.py", "bot.py", "worker.py"].filter((f) => exists(path.join(repo, f)));
      const pkgMain = [...walkFiles(repo, (f) => path.basename(f) === "__main__.py" && rel(repo, f).split("/").length <= 3)][0];
      const def = cands[0] ?? (pkgMain ? `-m ${moduleOf(repo, path.dirname(pkgMain) + ".py").module}` : "main.py");
      const ans = await P.ask("What runs the app? (script.py [args] or -m package [args])", def);
      entry = ans.split(/\s+/).filter(Boolean);
      serverLabel = "python " + ans;
    }

    // ---- Django specifics
    let collectstatic: string | null = null;
    if (fw === "django") {
      const settings = files.filter((f) => /settings/.test(f)).map(readText).join("\n");
      const manage = readText(path.join(repo, "manage.py"));
      const sm = /DJANGO_SETTINGS_MODULE['"]\s*,\s*['"]([\w.]+)['"]/.exec(manage)?.[1];
      if (sm) env.push(["DJANGO_SETTINGS_MODULE", sm]);
      if (/STATIC_ROOT/.test(settings) && (await P.confirm("Run `manage.py collectstatic` during the build?", true))) {
        collectstatic = "/venv/bin/python manage.py collectstatic --noinput";
        if (!has(t, "whitenoise")) actions.push({ short: "Serve static files: add WhiteNoise (or a CDN/ingress)", md: "Django doesn't serve static files in production. Add `whitenoise` to the dependencies and its middleware, or serve `STATIC_ROOT` from a CDN or the ingress." });
        actions.push({ short: "collectstatic may need dummy settings env vars at build time", md: "If `collectstatic` fails during `docker build` because settings require env vars (e.g. `SECRET_KEY`), give it harmless build-only values in the build stage: `RUN SECRET_KEY=build-only /venv/bin/python manage.py collectstatic --noinput`." });
      } else if (!/STATIC_ROOT/.test(settings)) info("STATIC_ROOT isn't set, so collectstatic is skipped");
      actions.push({ short: "Run database migrations as a separate Job/init container", md: "Run `migrate` outside the app container, e.g. a Kubernetes Job or init container using the same image with `command: [\"/venv/bin/python3\", \"manage.py\", \"migrate\"]`. There is no shell for a start script that migrates first." });
      actions.push({ short: "Set ALLOWED_HOSTS, DEBUG=False and SECRET_KEY from env", md: "Make sure `ALLOWED_HOSTS`, `DEBUG` and `SECRET_KEY` come from environment variables in production settings." });
    }

    // ---- health and image
    section("Health check and runtime image");
    const hDet = detectHealth(files, fw);
    if (hDet) info(`health endpoint found: ${s(hDet, "bold")}`);
    const hAns = await P.ask("Health check path ('none' = no HEALTHCHECK)", hDet ?? (fw === "generic" ? "none" : "/health"),
      (v) => (v === "none" || v.startsWith("/") ? null : "start with / or enter 'none'"));
    const health = hAns === "none" ? null : hAns;
    if (health && !hDet) {
      const snip: Record<Fw, string> = {
        fastapi: `\`@app.get("${health}")\` returning \`{"status": "ok"}\``, starlette: `a \`Route("${health}", ...)\` returning 200`,
        flask: `\`@app.get("${health}")\` returning \`{"status": "ok"}\``, django: `a view wired as \`path("${health.replace(/^\//, "")}", ...)\` returning \`HttpResponse("ok")\` (excluded from auth)`,
        generic: "a small HTTP endpoint",
      };
      actions.push({ short: `Add a ${health} endpoint (the HEALTHCHECK calls it)`, md: `No health endpoint was found. Add one at \`${health}\`, e.g. ${snip[fw]}; the Dockerfile HEALTHCHECK and the Kubernetes probes call it.` });
    }
    const image = await askImage(P, "Runtime base image", RUNTIME_IMAGE);

    // ---- checks
    const envs = envVars(files);
    const libs = Object.keys(SYSTEM_LIBS).filter((k) => has(t, k) && !(k === "psycopg" && /psycopg\[[^\]]*binary/.test(t)) && !(k === "psycopg2" && has(t, "psycopg2-binary") && !/(^|[\s"'])psycopg2\s*([<>=~!;"'\s]|$)/m.test(t)));
    const shells = shellUsage(repo, files);
    if (libs.length) actions.push({ short: `${libs.length} dependenc${libs.length > 1 ? "ies need" : "y needs"} system libraries distroless doesn't ship`, md: `Replace or check ${libs.map((l) => `\`${l}\``).join(", ")}: they need system libraries or binaries that distroless doesn't ship. See [Runtime checks](#runtime-checks).` });
    if (shells.length) actions.push({ short: `Review ${shells.length} place(s) that run shell commands`, md: `Review ${shells.length} place(s) that use \`shell=True\`, \`os.system\` or external tools; there is no shell at runtime. See [Runtime checks](#runtime-checks).` });
    if (envs.length) actions.push({ short: `Set the ${envs.length} env var(s) the app reads in your deployment`, md: "Set the environment variables the app reads (listed under [Environment variables](#environment-variables)) in your deployment manifests. Keep secrets in a secret store, not in the image." });
    if (pm === "poetry" && /^\s*packages\s*=/m.test(readText(path.join(repo, "pyproject.toml"))))
      actions.push({ short: "Poetry package: check that imports work without installing the project", md: "`poetry install --no-root` installs dependencies only; your code runs from `/app`. If the app relies on being installed as a package (entry points, `src/` layout), add `RUN poetry install --only main` after `COPY . .`." });

    const b: Build = { pm, buildImage, compiler, reqFile, reqNeedsSource, extraPkgs, image, port, entry, env, health, collectstatic };
    plan.write(dockerfile, renderDockerfile(b), "2-stage distroless build");

    const sections = [
      ["## Runtime", "", mdTable(["", ""], [
        ["Framework", FW_LABEL[fw]], ["Server", serverLabel], ["Dependencies", pm === "pip" ? `pip (\`${reqFile}\`)` : pm === "pip-project" ? "pip (`pip install .`)" : pm],
        ["Python", `${RUNTIME_PY.join(".")} (build: \`${buildImage}\`, runtime: \`${image.replace(/@sha256:.*/, "")}\`)`],
        ["Entrypoint", `\`${["/venv/bin/python3", ...entry].join(" ")}\``], ["Health check", health ? `\`GET ${health}\` via urllib` : "none"],
      ]), "",
      "The venv is built against `/usr/bin/python`, the path the distroless image provides, so it runs unchanged there. `ENTRYPOINT` uses exec form: there is no shell, so `$VARS` in it are not expanded. Settings that must change per environment belong in env vars the app reads.", "",
      "- `readOnlyRootFilesystem: true`: Python writes no bytecode (`PYTHONDONTWRITEBYTECODE=1`); mount an `emptyDir` at `/tmp` if the app uses temp files or uploads.",
      ...(serverLabel.startsWith("gunicorn") ? ["- Gunicorn binds `0.0.0.0:$PORT` by default and keeps its worker heartbeat in `/dev/shm`, so it works on a read-only root. Tune workers with `GUNICORN_CMD_ARGS=\"--workers 4\"`."] : []),
      ...(pm === "uv" ? ["- uv never downloads its own Python here (`UV_PYTHON_DOWNLOADS=never`); it installs into `/venv`, created from the runtime-matching interpreter."] : []),
      ].join("\n"),
      ["## Environment variables", "", envs.length ? `Found ${envs.length} variable(s) read through \`os.environ\`, \`os.getenv\`, django-environ or python-decouple:` : "No environment variable reads were found in the scanned sources.", "",
        ...(envs.length ? [mdTable(["Variable"], envs.map((v) => [`\`${v}\``]))] : []), "",
        "Settings classes (e.g. pydantic `BaseSettings`) read env vars by field name and aren't listed here."].join("\n"),
      ["## Runtime checks", "",
        ...(libs.length ? ["Dependencies that need system libraries or binaries distroless doesn't have:", "", ...libs.map((l) => `- \`${l}\`: ${SYSTEM_LIBS[l]}`), ""] : ["No dependencies with known distroless issues were found.", ""]),
        ...(shells.length ? ["Code that runs shell commands or external tools:", "", ...shells.map((h) => `- \`${h}\``), ""] : [])].join("\n"),
    ];
    const name = (/^\s*name\s*=\s*["']([^"']+)["']/m.exec(readText(path.join(repo, "pyproject.toml")))?.[1] ?? path.basename(repo)).replace(/[^a-z0-9._-]/gi, "-").toLowerCase();
    return {
      stack: `Python (${FW_LABEL[fw]})`, imageName: name || "app", port, runtimeImage: image,
      summary: [`Framework: ${FW_LABEL[fw]}`, `Server: ${serverLabel}`, `Dependencies: ${pm}`, `Python: ${RUNTIME_PY.join(".")}`],
      consoleFacts: [
        `${s(G.ok, "green")} ${serverLabel} on Python ${RUNTIME_PY.join(".")} (${pm})`,
        `${s(G.bullet, "gray")} health check: ${health ?? "none"}`,
        `${s(G.bullet, "gray")} ${envs.length} env var(s) found${libs.length ? `, ${s(libs.length + " dependency warning(s)", "yellow")}` : ""}`,
      ],
      actions, sections, runEnv: envs.slice(0, 5).map((v) => `-e ${v}=...`), verify: [],
      dockerignoreRecommended: [".git", ".venv", "venv", "env", "__pycache__", "*.pyc", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".coverage", "htmlcov", ".env", ".env.*", "!.env.example", "*.sqlite3", "node_modules"],
      dockerignoreNeeded: ["pyproject.toml", ...(pm === "uv" ? ["uv.lock"] : pm === "poetry" ? ["poetry.lock"] : pm === "pipenv" ? ["Pipfile", "Pipfile.lock"] : []), ...(reqFile ? [reqFile] : [])].filter((f) => exists(path.join(repo, f))),
      reviewHits: reviewReferences(repo, new Set(), /\bmanage\.py (?:runserver|migrate)\b|\bflask run\b/), healthPath: health,
    };
  },
};
