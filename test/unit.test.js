// Unit tests for the parsers and analysis. Run with `npm test` (builds first).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const files = require("../dist/core/files");
const docker = require("../dist/core/docker");
const an = require("../dist/stacks/angular/analysis");
const spa = require("../dist/stacks/shared/static-spa");
const node = require("../dist/stacks/node");
const py = require("../dist/stacks/python");
const react = require("../dist/stacks/react");
const ra = require("../dist/stacks/react/analysis");
const stacks = require("../dist/stacks");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "dls-"));
const write = (dir, rel, text) => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
  return p;
};

// ---- core --------------------------------------------------------------------------------
test("stripJsonc keeps // inside strings and drops comments + trailing commas", () => {
  const src = '{\n  // c\n  "url": "http://x/y", /* b */ "a": [1,2,],\n}';
  assert.deepEqual(JSON.parse(files.stripJsonc(src)), { url: "http://x/y", a: [1, 2] });
});

test("camelToEnv", () => {
  assert.equal(files.camelToEnv("apiBaseUrl"), "API_BASE_URL");
  assert.equal(files.camelToEnv("authClientId"), "AUTH_CLIENT_ID");
  assert.equal(files.camelToEnv("oauth2Scope"), "OAUTH2_SCOPE");
});

test("dockerignoreExcludes: parents, globs, negation, last match wins", () => {
  assert.equal(docker.dockerignoreExcludes("libs/a/b.ts", ["libs"]), true);
  assert.equal(docker.dockerignoreExcludes("src/x.env", ["*.env"]), false); // * doesn't cross /
  assert.equal(docker.dockerignoreExcludes("src/x.env", ["**/*.env"]), true);
  assert.equal(docker.dockerignoreExcludes("package.json", ["*", "!package.json"]), false);
  assert.equal(docker.dockerignoreExcludes(".env.example", [".env.*", "!.env.example"]), false);
});

test("parseExistingDockerfile splits 'install && build' and reads node/port", () => {
  const d = tmp();
  const p = write(d, "Dockerfile", "FROM node:20-alpine AS b\nCOPY .npmrc ./\nRUN npm install && \\\n  npm run build\nEXPOSE 4000\nCMD [\"npm\",\"start\"]\n");
  const r = docker.parseExistingDockerfile(p);
  assert.equal(r.nodeMajor, "20");
  assert.equal(r.install, "npm install");
  assert.equal(r.build, "npm run build");
  assert.equal(r.port, "4000");
  assert.deepEqual(r.extras, [".npmrc"]);
});

// ---- Angular analysis ---------------------------------------------------------------------
test("parseEnvironmentFile: literals, nested, as const, non-literal values", () => {
  const d = tmp();
  const p = write(d, "environment.ts", `
    const base = 'x';
    export const environment = {
      production: false, apiBaseUrl: 'https://api', retries: -2, tags: ['a', "b"],
      auth: { clientId: \`abc\`, 'scope-x': 'openid' },
      computed: base + '/v1', fn() { return 1; },
    } as const;`);
  const [name, obj] = an.parseEnvironmentFile(p);
  assert.equal(name, "environment");
  assert.equal(obj.retries, -2);
  assert.deepEqual(obj.tags, ["a", "b"]);
  assert.deepEqual(obj.auth, { clientId: "abc", "scope-x": "openid" });
  assert.ok(obj.computed instanceof an.Unparsed);
  assert.ok(obj.fn instanceof an.Unparsed);
});

test("flatten + flatJoin", () => {
  assert.deepEqual(an.flatten({ a: 1, auth: { clientId: "x", deep: { k: true } } }).map(([p]) => an.flatJoin(p)), ["a", "authClientId", "authDeepK"]);
});

const SVC = `import { Injectable } from '@angular/core';
import { environment } from '../environments/environment';

export const API = environment.apiBaseUrl;
export const lazy = () => environment.apiBaseUrl;

@Injectable({ providedIn: 'root' })
export class Api {
  static readonly S = environment.apiBaseUrl;
  private readonly base = environment.apiBaseUrl;
  private readonly id = environment.auth?.clientId;
  private readonly prod = environment.production;
  all() { return { ...environment }; }
  url(p: string) { return \`\${environment.apiBaseUrl}/\${p}\`; }
  missing() { return environment.nope; }
}
`;

function scan(dir, file, flat) {
  return an.scanUsages({
    repo: dir, files: [file], moved: new Set(["apiBaseUrl", "auth"]), kept: new Set(["production"]),
    flatMap: flat ? new Map([["apiBaseUrl", "apiBaseUrl"], ["auth.clientId", "authClientId"]]) : null,
    flattenedParents: new Set(flat ? ["auth"] : []), bootstrapFiles: new Set(),
  });
}

test("scanUsages classifies eager/deferred/whole/unknown/build-time on the AST", () => {
  const d = tmp();
  const f = write(d, "src/app/api.ts", SVC);
  const { usages } = scan(d, f, true);
  const by = (line) => usages.find((u) => u.line === line);
  assert.equal(by(4).reason, "eager"); // module level
  assert.equal(by(5).status, "rewritable"); // arrow function
  assert.equal(by(9).reason, "eager"); // static field
  assert.equal(by(10).status, "rewritable"); // instance field
  assert.equal(by(11).status, "rewritable"); // optional chain into flattened key
  assert.equal(by(12).status, "build-time");
  assert.equal(by(13).reason, "whole"); // spread
  assert.equal(by(14).status, "rewritable"); // template literal in method
  assert.equal(by(15).reason, "unknown");
});

test("applyRewrites keeps optional chaining, keeps import while still used, adds runtime-config import", () => {
  const d = tmp();
  const f = write(d, "src/app/api.ts", SVC);
  const svc = path.join(d, "src/app/core/config/_runtime-config.service.ts");
  const { edits } = scan(d, f, true);
  const out = an.applyRewrites(fs.readFileSync(f, "utf8"), edits.get(f), svc, f);
  assert.match(out, /private readonly id = runtimeConfig\(\)\?\.authClientId;/);
  assert.match(out, /\$\{runtimeConfig\(\)\.apiBaseUrl\}\/\$\{p\}/);
  assert.match(out, /import \{ environment \} from '\.\.\/environments\/environment';/); // still used (eager reads)
  assert.match(out, /import \{ runtimeConfig \} from '\.\/core\/config\/_runtime-config\.service';/);
});

test("applyRewrites drops the environment import when nothing uses it", () => {
  const d = tmp();
  const f = write(d, "src/a.ts", "import { environment } from './environments/environment';\nexport class A { u() { return environment.apiBaseUrl; } }\n");
  const { edits } = scan(d, f, false);
  const out = an.applyRewrites(fs.readFileSync(f, "utf8"), edits.get(f), path.join(d, "src/svc.ts"), f);
  assert.doesNotMatch(out, /environments\/environment/);
  assert.match(out, /return runtimeConfig\(\)\.apiBaseUrl;/);
});

test("planProviderEdit: single-line, multi-line, empty and already present", () => {
  const d = tmp();
  const svc = path.join(d, "src/app/core/config/_runtime-config.service.ts");
  const one = write(d, "src/app/one.ts", "import { X } from 'x';\nexport const appConfig = { providers: [provideRouter(routes)] };\n");
  const [t1, s1] = an.planProviderEdit(one, svc, "c");
  assert.equal(s1, "edited");
  assert.match(t1, /providers: \[\n  provideRuntimeConfig\(\), \/\/ c\n  provideRouter\(routes\)\]/);
  assert.match(t1, /import \{ provideRuntimeConfig \} from '\.\/core\/config\/_runtime-config\.service';/);
  const multi = write(d, "src/app/multi.ts", "export const appConfig = {\n  providers: [\n    provideRouter(routes),\n  ],\n};\n");
  assert.match(an.planProviderEdit(multi, svc, "c")[0], /providers: \[\n    provideRuntimeConfig\(\), \/\/ c\n    provideRouter/);
  const empty = write(d, "src/app/empty.ts", "export const appConfig = { providers: [] };\n");
  assert.match(an.planProviderEdit(empty, svc, "c")[0], /providers: \[provideRuntimeConfig\(\)\]/);
  const none = write(d, "src/app/none.ts", "export const appConfig = {};\n");
  assert.equal(an.planProviderEdit(none, svc, "c")[1], "no-providers");
  assert.equal(an.planProviderEdit(write(d, "src/app/p.ts", t1), svc, "c")[1], "present");
});

test("findBootstrapTarget: standalone import, inline config, NgModule", () => {
  const d = tmp();
  write(d, "src/app/app.config.ts", "export const appConfig = { providers: [] };\n");
  const m1 = write(d, "src/main.ts", "import { appConfig } from './app/app.config';\nbootstrapApplication(App, appConfig).catch(console.error);\n");
  assert.equal(an.findBootstrapTarget(m1).target, path.join(d, "src/app/app.config.ts"));
  const m2 = write(d, "src/main2.ts", "bootstrapApplication(App, { providers: [] });\n");
  assert.equal(an.findBootstrapTarget(m2).target, m2);
  write(d, "src/app/app.module.ts", "export class AppModule {}\n");
  const m3 = write(d, "src/main3.ts", "import { AppModule } from './app/app.module';\nplatformBrowserDynamic().bootstrapModule(AppModule);\n");
  const r3 = an.findBootstrapTarget(m3);
  assert.equal(r3.kind, "ngmodule");
  assert.equal(r3.target, path.join(d, "src/app/app.module.ts"));
});

test("generated Go escapes non-ASCII and quotes", () => {
  const go = spa.renderGeneratedGo({ enabled: true, url: "/config.json", fields: [["k", "K", false]], override: null }, [["X-Test", 'a"b – c']]);
  assert.match(go, /\{"X-Test", "a\\"b \\u2013 c"\}/);
  assert.match(go, /\{Key: "k", Env: "K", Raw: false\}/);
});

// ---- Node ---------------------------------------------------------------------------------
test("scriptEntry reads the file node runs", () => {
  assert.equal(node.scriptEntry("node dist/main"), "dist/main.js");
  assert.equal(node.scriptEntry("node --enable-source-maps dist/server.js"), "dist/server.js");
  assert.equal(node.scriptEntry("cross-env NODE_ENV=production node ./build/index.mjs"), "build/index.mjs");
  assert.equal(node.scriptEntry("nest start"), null);
});

test("detectEntry: Nest default, tsconfig outDir, dev runner flagged only without a node script", () => {
  const d = tmp();
  write(d, "tsconfig.json", '{ "compilerOptions": { "outDir": "./out", "rootDir": "src" } }');
  write(d, "src/index.ts", "");
  assert.deepEqual(node.detectEntry(d, { scripts: { start: "tsx src/index.ts" } }, "express"), { entry: "out/index.js", why: "tsconfig outDir + src/index.ts", devRunner: "tsx" });
  assert.equal(node.detectEntry(d, { scripts: { start: "nest start", "start:prod": "node dist/main" } }, "nest").devRunner, null);
});

test("nextOutput finds the config object across shapes", () => {
  const d = tmp();
  const a = write(d, "a.ts", 'import type { NextConfig } from "next";\nconst nextConfig: NextConfig = {\n  reactStrictMode: true,\n};\nexport default nextConfig;\n');
  assert.match(node.nextOutput(a).edited, /\{\n  output: "standalone",\n  reactStrictMode: true,/);
  const b = write(d, "b.js", "module.exports = withBundleAnalyzer({ images: {} });\n");
  assert.match(node.nextOutput(b).edited, /\{ output: "standalone", images/);
  const c = write(d, "c.mjs", "export default (phase) => ({ output: 'export' });\n");
  assert.equal(node.nextOutput(c).output, "export");
  const e = write(d, "e.mjs", "const x = 1;\nexport default x;\n");
  assert.deepEqual(node.nextOutput(e), { output: null, edited: null });
});

test("detectHealth: Nest controller, Express route, Next route handler", () => {
  const d = tmp();
  const nest = write(d, "h.controller.ts", "@Controller('healthz') export class H {}");
  assert.equal(node.detectHealth(d, [nest], "nest"), "/healthz");
  const ex = write(d, "s.ts", "app.get('/api/health', h)");
  assert.equal(node.detectHealth(d, [ex], "express"), "/api/health");
  write(d, "app/api/ready/route.ts", "export function GET() {}");
  assert.equal(node.detectHealth(d, [], "next"), "/api/ready");
});

// ---- Python -------------------------------------------------------------------------------
test("specAllows against the 3.13 runtime", () => {
  const v = [3, 13];
  for (const s of [">=3.10", ">=3.11,<4", "^3.11", "~=3.12", "==3.13.*", ">3.12", "!=3.12.*", "3.13"]) assert.equal(py.specAllows(s === "3.13" ? "==3.13.*" : s, v), true, s);
  for (const s of ["<3.13", ">=3.14", "==3.12.*", "~3.12", "^3.14", "~=3.14"]) assert.equal(py.specAllows(s, v), false, s);
});

test("has() matches dependency names, not substrings; binary psycopg2 is distinct", () => {
  const t = 'dependencies = ["fastapi>=0.1", "uvicorn[standard]", "psycopg2-binary==2.9"]\nflask-cors\n';
  assert.equal(py.has(t, "fastapi"), true);
  assert.equal(py.has(t, "uvicorn"), true);
  assert.equal(py.has(t, "flask"), false);
  assert.equal(py.has(t, "psycopg2-binary"), true);
  assert.equal(/(^|[\s"'])psycopg2\s*([<>=~!;"'\s]|$)/m.test(t), false); // plain psycopg2 absent
});

test("findAsgiWsgi: src layout, typed assignment, Flask factory, Django wsgi", () => {
  const d = tmp();
  const f = write(d, "src/svc/main.py", "from fastapi import FastAPI\napi: FastAPI = FastAPI()\n");
  assert.deepEqual(py.findAsgiWsgi(d, [f], "fastapi"), { target: "svc.main:api", srcRoot: "src", file: f, why: "FastAPI() in src/svc/main.py" });
  const g = write(d, "web/__init__.py", "def create_app():\n    return Flask(__name__)\n");
  assert.equal(py.findAsgiWsgi(d, [g], "flask").target, "web:create_app()");
  write(d, "manage.py", "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'site1.settings')\n");
  write(d, "site1/wsgi.py", "application = get_wsgi_application()\n");
  assert.equal(py.findAsgiWsgi(d, [], "django").target, "site1.wsgi:application");
});

test("has() recognises the uvicorn-worker distribution under either spelling", () => {
  assert.equal(py.has("uvicorn-worker==0.4.0\n", "uvicorn-worker"), true);
  assert.equal(py.has("uvicorn_worker==0.4.0\n", "uvicorn-worker"), true);
  // `uvicorn` alone must not satisfy a uvicorn-worker check, and vice versa.
  assert.equal(py.has("uvicorn==0.37.0\n", "uvicorn-worker"), false);
  assert.equal(py.has("uvicorn-worker==0.4.0\n", "uvicorn"), false);
});

// ---- Plan: filesystem safety ----------------------------------------------------------------
test("Plan refuses paths that resolve outside the repo", () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  const plan = new files.Plan(repo);

  plan.write(path.join(repo, "nested", "ok.txt"), "x", "inside"); // sanity: nested creates are fine
  assert.throws(() => plan.write(path.join(repo, "..", "escape.txt"), "x", "bad"), /outside/);
  assert.throws(() => plan.write(path.join(repo, "a", "..", "..", "escape.txt"), "x", "bad"), /outside/);
  assert.throws(() => plan.remove(path.join(root, "sibling.txt"), "bad"), /outside/);
  assert.throws(() => plan.write(repo, "x", "bad"), /outside/); // the repo itself is not a target
});

test("Plan refuses to write through a symlink that leaves the repo", { skip: process.platform === "win32" ? "symlinks need elevation on Windows" : false }, () => {
  const root = tmp();
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "secret.txt"), "original");

  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "link.txt"));
  fs.symlinkSync(outside, path.join(repo, "linkdir"), "dir");

  const plan = new files.Plan(repo);
  assert.throws(() => plan.write(path.join(repo, "link.txt"), "x", "bad"), /outside/);
  assert.throws(() => plan.write(path.join(repo, "linkdir", "new.txt"), "x", "bad"), /outside/);
  assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "original");
});

test("Plan.apply writes every planned file and backs up what it replaces", () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, "Dockerfile"), "old");
  const plan = new files.Plan(repo);
  plan.write(path.join(repo, "Dockerfile"), "new", "replace");
  plan.write(path.join(repo, "sub", "created.txt"), "hello", "create");
  plan.remove(path.join(repo, "gone.txt"), "remove"); // missing file: a no-op, not an error

  const backup = plan.apply();
  assert.equal(fs.readFileSync(path.join(repo, "Dockerfile"), "utf8"), "new");
  assert.equal(fs.readFileSync(path.join(repo, "sub", "created.txt"), "utf8"), "hello");
  assert.equal(fs.readFileSync(path.join(backup, "Dockerfile"), "utf8"), "old");
});

test("every version-bearing file agrees with package.json", () => {
  const report = require("../dist/core/report");
  const pkg = require("../package.json");
  const lock = require("../package-lock.json");

  assert.equal(report.VERSION, pkg.version, "bump src/core/report.ts VERSION together with package.json");
  // The publish workflow checks the git tag against package.json, not the lockfile, so a
  // stale lockfile version would otherwise ship unnoticed. `npm install --package-lock-only`
  // is the fix; do not hand-edit the lockfile.
  assert.equal(lock.version, pkg.version, "package-lock.json is stale: run `npm install --package-lock-only`");
  assert.equal(lock.packages[""].version, pkg.version, "package-lock.json root package is stale");
  assert.match(fs.readFileSync(path.join(__dirname, "..", "CHANGELOG.md"), "utf8"), new RegExp(`^## ${pkg.version.replace(/\./g, "\\.")}$`, "m"),
    "CHANGELOG.md has no section for the current version");
});

test("back-to-back runs get separate backup directories", () => {
  const repo = tmp();
  fs.writeFileSync(path.join(repo, "Dockerfile"), "original");

  const first = new files.Plan(repo);
  first.write(path.join(repo, "Dockerfile"), "run-1", "replace");
  const b1 = first.apply();

  // Same second, same stamp: the second run must not copy over the first run's backups,
  // or the user's original file is lost.
  const second = new files.Plan(repo);
  second.write(path.join(repo, "Dockerfile"), "run-2", "replace");
  const b2 = second.apply();

  assert.notEqual(b1, b2, "each run needs its own backup directory");
  assert.equal(fs.readFileSync(path.join(b1, "Dockerfile"), "utf8"), "original");
  assert.equal(fs.readFileSync(path.join(b2, "Dockerfile"), "utf8"), "run-1");
  assert.equal(fs.readdirSync(path.join(repo, files.BACKUP_DIR)).length, 2);
});

// ---- React --------------------------------------------------------------------------------
const { spawnSync } = require("node:child_process");
const CLI = path.join(__dirname, "..", "dist", "cli.js");

/** Runs the real CLI with --yes over a temp project: generation tests without Docker. */
function cli(dir, stack) {
  const r = spawnSync(process.execPath, [CLI, ...(stack ? [stack] : []), dir, "--yes"], {
    encoding: "utf8", env: { ...process.env, NO_COLOR: "1", DISTROLESS_SETUP_ASCII: "1", FORCE_COLOR: "" },
  });
  const read = (rel) => (fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), "utf8") : null);
  return { code: r.status, out: r.stdout + r.stderr, read };
}

/** A temp project from a { path: content } map; objects are written as JSON. */
function project(filesMap) {
  const d = tmp();
  for (const [rel, body] of Object.entries(filesMap)) write(d, rel, typeof body === "string" ? body : JSON.stringify(body));
  return d;
}

const VITE_PKG = { name: "web", scripts: { dev: "vite", build: "tsc && vite build", preview: "vite preview" },
  dependencies: { react: "19", "react-dom": "19" }, devDependencies: { vite: "8", "@vitejs/plugin-react": "6" } };
const CRA_PKG = { name: "cra-app", scripts: { start: "react-scripts start", build: "react-scripts build" },
  dependencies: { react: "18", "react-dom": "18", "react-scripts": "5.0.1" } };
const RR_PKG = { name: "rr-app", scripts: { build: "react-router build", dev: "react-router dev", start: "react-router-serve ./build/server/index.js" },
  dependencies: { react: "19", "react-dom": "19", "react-router": "7", "@react-router/node": "7", "@react-router/serve": "7" }, devDependencies: { "@react-router/dev": "7", vite: "7" } };

const winner = (d) => stacks.detectStacks(d)[0]?.st.id ?? null;
const reactScore = (d) => react.reactStack.detect(d)?.score ?? null;

test("detection competition: static React apps pick React, servers and Next.js keep Node", () => {
  const cases = [
    ["React + Vite", { "package.json": VITE_PKG, "index.html": "<div id=root></div>" }, "react"],
    ["React + Vite served by `serve` in start", { "package.json": { ...VITE_PKG, scripts: { ...VITE_PKG.scripts, start: "serve -s dist" } } }, "react"],
    ["React + CRA", { "package.json": CRA_PKG, "public/index.html": "<div id=root></div>" }, "react"],
    ["React Router ssr:false", { "package.json": RR_PKG, "react-router.config.ts": "export default { ssr: false } satisfies Config;" }, "react"],
    ["React Router with SSR (default)", { "package.json": RR_PKG, "react-router.config.ts": "export default { appDirectory: 'app' };" }, "node"],
    ["Next.js + React", { "package.json": { scripts: { build: "next build", start: "next start" }, dependencies: { next: "15", react: "19", "react-dom": "19" } } }, "node"],
    ["Angular", { "angular.json": "{}", "package.json": { dependencies: { "@angular/core": "20" } } }, "angular"],
    ["Express + React rendered server-side", { "package.json": { scripts: { build: "tsc", start: "node dist/server.js" }, dependencies: { express: "5", react: "19", "react-dom": "19" } } }, "node"],
    ["Express + Vite + React (SSR dev setup)", { "package.json": { ...VITE_PKG, scripts: { ...VITE_PKG.scripts, start: "node server.js" }, dependencies: { ...VITE_PKG.dependencies, express: "5" } } }, "node"],
    ["plain Node package", { "package.json": { scripts: { start: "node index.js" }, dependencies: { pino: "9" } } }, "node"],
    ["Vite without React", { "package.json": { scripts: { build: "vite build" }, devDependencies: { vite: "8" } } }, "node"],
    ["unknown React builder", { "package.json": { scripts: { build: "webpack --mode production" }, dependencies: { react: "19", "react-dom": "19" }, devDependencies: { webpack: "5" } }, "public/index.html": "<div></div>" }, "react"],
  ];
  for (const [name, filesMap, want] of cases) assert.equal(winner(project(filesMap)), want, name);
});

test("React detection: evidence and exclusions", () => {
  assert.equal(reactScore(project({ "package.json": { dependencies: { pino: "9" } } })), null, "no React evidence");
  assert.equal(reactScore(project({ "package.json": { scripts: { build: "vite build" }, devDependencies: { vite: "8" } } })), null, "Vite alone is not React");
  assert.equal(reactScore(project({ "package.json": { dependencies: { react: "19" } } })), null, "React dependency alone, no build or entry point");
  assert.equal(reactScore(project({ "package.json": { scripts: { build: "tsc" }, dependencies: { react: "19" } } })), null, "no index.html: no frontend evidence");
  assert.equal(reactScore(project({ "package.json": { dependencies: { next: "15", react: "19" } } })), null, "Next.js is the node stack's");
  assert.equal(reactScore(project({ "package.json": { dependencies: { "@remix-run/react": "2", react: "18" } } })), null, "Remix is not claimed");
  assert.equal(reactScore(project({ "package.json": { dependencies: { gatsby: "5", react: "18" } } })), null, "Gatsby is not claimed");
  assert.equal(reactScore(project({ "angular.json": "{}", "package.json": VITE_PKG })), null, "Angular workspace");
  assert.equal(reactScore(project({ "package.json": { dependencies: { react: "19" } }, "vite.config.mts": "export default {}" })), 0.95, "vite.config.mts is Vite evidence");
  assert.equal(reactScore(project({ "package.json": { scripts: { build: "vite build" }, dependencies: { react: "19" } } })), 0.95, "`vite build` script is Vite evidence");
  assert.equal(reactScore(project({ "package.json": RR_PKG })), 0.4, "React Router without a config defaults to SSR");
  // Node's own detection is unchanged by the React stack: a CRA app still scores as before.
  assert.equal(node.nodeStack.detect(project({ "package.json": CRA_PKG })).score, 0.9);
});

test("React Router config: only a literal ssr: false counts as SPA mode", () => {
  const rr = (cfg) => ra.reactRouterSettings(project(cfg === null ? {} : { "react-router.config.ts": cfg }));
  assert.equal(rr("import type { Config } from '@react-router/dev/config';\nexport default { ssr: false } satisfies Config;\n").ssr, false);
  assert.equal(rr("export default { ssr: true };").ssr, true);
  assert.equal(rr("export default { appDirectory: 'app' };").ssr, "default");
  assert.equal(rr(null).ssr, "default");
  assert.equal(rr("export default { // ssr: false\n  appDirectory: 'app' };").ssr, "default", "a comment is not config");
  assert.equal(rr("export default { ssr: process.env.SPA !== '1' };").ssr, "dynamic");
  assert.equal(rr("const spa = true;\nexport default { ssr: !spa };").ssr, "dynamic");
  assert.equal(rr("export default process.env.X ? { ssr: false } : { ssr: true };").ssr, "dynamic", "different literals per branch");
  assert.equal(rr("export default { ssr: false };").outDir, "build/client");
  assert.equal(rr("export default { ssr: false, buildDirectory: 'out' };").outDir, "out/client");
  const full = rr("export default { ssr: false, basename: '/app', prerender: ['/about'] };");
  assert.equal(full.basename, "/app");
  assert.equal(full.prerender, true);
});

test("Vite config: outDir/root/base read statically, dynamic values reported, plugin options ignored", () => {
  const vite = (cfg, scripts = {}) => ra.viteSettings(project(cfg === null ? {} : { "vite.config.ts": cfg }), { scripts });
  assert.equal(vite(null).outDir, "dist");
  assert.equal(vite("export default defineConfig({ plugins: [react()] });").outDir, "dist");
  assert.equal(vite("export default defineConfig({ build: { outDir: 'build/web' } });").outDir, "build/web");
  assert.equal(vite("export default defineConfig({ root: 'client', build: { outDir: '../www' } });").outDir, "www");
  assert.equal(vite("export default defineConfig(({ mode }) => ({ build: { outDir: `out` } }));").outDir, "out");
  assert.equal(vite("export default defineConfig({ plugins: [pwa({ build: { outDir: 'nope' } }), x({ outDir: 'nope' })] });").outDir, "dist", "plugin options are not Vite's build.outDir");
  const dyn = vite("export default defineConfig({ build: { outDir: process.env.OUT } });");
  assert.equal(dyn.outDir, null);
  assert.match(dyn.notes.join(), /outDir/);
  assert.equal(vite("export default defineConfig({ build: { outDir: '/abs/out' } });").outDir, null);
  assert.equal(vite("export default defineConfig({ build: { outDir: '..' } });").outDir, null, "outside the repo");
  assert.equal(vite(null, { build: "vite build --outDir public-build" }).outDir, "public-build", "CLI flag wins");
  assert.equal(vite("export default defineConfig({ base: '/admin/' });").base, "/admin/");
  assert.equal(vite("export default defineConfig({ envPrefix: 'APP_' });").envPrefix, "APP_");
});

test("base path from Vite base, CRA homepage and React Router basename", () => {
  const vite = (base) => ({ base, outDir: "dist", envPrefix: null, notes: [], file: null });
  assert.deepEqual(ra.basePath("vite", {}, vite("/admin/"), null), { value: "/admin/", source: "`base` in the Vite config" });
  assert.equal(ra.basePath("vite", {}, vite("./"), null), null, "relative base works from any path");
  assert.equal(ra.basePath("vite", {}, vite("/"), null), null);
  assert.equal(ra.basePath("cra", { homepage: "https://user.github.io/my-app" }, null, null).value, "/my-app/");
  assert.equal(ra.basePath("cra", { homepage: "." }, null, null), null);
  assert.equal(ra.basePath("react-router", {}, vite(null), { basename: "/app" }).value, "/app/");
});

test("client env scan: Vite and CRA forms, built-ins excluded, unprefixed and credential-like names flagged", () => {
  const d = project({
    "src/a.ts": [
      "const u = import.meta.env.VITE_API_URL;",
      "const k = import.meta.env['VITE_STRIPE_SECRET_KEY'];",
      "const m = import.meta.env?.VITE_OPTIONAL;",
      "const { VITE_A, VITE_B: b, MODE } = import.meta.env;",
      "if (import.meta.env.PROD && import.meta.env.DEV === false && import.meta.env.BASE_URL && import.meta.env.SSR) {}",
      "const bad = import.meta.env.API_URL;",
    ].join("\n"),
    "src/b.js": "fetch(process.env.REACT_APP_API_URL); const t = process.env[\"REACT_APP_AUTH_TOKEN\"]; const { REACT_APP_C } = process.env; process.env.NODE_ENV;",
    "index.html": "<title>%VITE_APP_TITLE%</title>",
    "public/index.html": "<title>%REACT_APP_NAME%</title>",
    "src/a.test.ts": "import.meta.env.VITE_ONLY_IN_TESTS",
    "vite.config.ts": "process.env.VITE_ONLY_IN_CONFIG; import.meta.env.VITE_ONLY_IN_CONFIG",
  });
  const r = ra.scanClientEnv(d, ra.clientFiles(d, []));
  assert.deepEqual(r.vars.map((v) => v.name), ["REACT_APP_API_URL", "REACT_APP_AUTH_TOKEN", "REACT_APP_C", "REACT_APP_NAME",
    "VITE_A", "VITE_API_URL", "VITE_APP_TITLE", "VITE_B", "VITE_OPTIONAL", "VITE_STRIPE_SECRET_KEY"]);
  assert.deepEqual(r.unprefixed, ["API_URL"], "Vite built-ins are not application variables");
  assert.deepEqual(r.vars.filter((v) => v.secretish).map((v) => v.name), ["REACT_APP_AUTH_TOKEN", "VITE_STRIPE_SECRET_KEY"]);
  assert.equal(r.vars.find((v) => v.name === "VITE_API_URL").where, "src/a.ts:1");
  assert.equal(r.vars.find((v) => v.name === "REACT_APP_API_URL").kind, "cra");
});

test("existing nginx Dockerfile: the COPY into /usr/share/nginx/html gives the output directory", () => {
  const d = tmp();
  const f = write(d, "Dockerfile", "FROM node:20 AS build\nWORKDIR /usr/src/app\nRUN npm ci && npm run build\nFROM nginx:alpine\nCOPY --from=build /usr/src/app/web-dist/ /usr/share/nginx/html\n");
  assert.equal(react.nginxCopySource(f), "web-dist");
  write(d, "Dockerfile", "FROM nginx\nCOPY --from=0 /etc/passwd /usr/share/nginx/html\n");
  assert.equal(react.nginxCopySource(f), null, "absolute paths outside the workdir are not an output directory");
});

test("react generation: Vite app gets a 3-stage static image, build ARGs and a hardened .dockerignore", () => {
  const d = project({ "package.json": VITE_PKG, "package-lock.json": "{}", "index.html": "<title>%VITE_APP_TITLE%</title>",
    "src/main.tsx": "console.log(import.meta.env.VITE_API_URL)", ".env.production": "VITE_API_URL=https://prod", ".env.example": "" });
  const r = cli(d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /React \+ Vite/);
  const df = r.read("Dockerfile");
  assert.match(df, /^FROM node:24-trixie-slim AS build$/m);
  assert.match(df, /^ARG VITE_API_URL\nARG VITE_APP_TITLE\nRUN npm run build$/m);
  assert.match(df, /^COPY --from=build --chown=65532:0 \/app\/dist \/app\/www$/m);
  assert.match(df, /^FROM gcr\.io\/distroless\/static-debian13:nonroot AS serve$/m);
  assert.match(df, /^USER 65532:0$/m);
  assert.doesNotMatch(df.slice(df.indexOf("AS serve")), /node_modules/);
  assert.ok(r.read("server/main.go").includes("func isHashedName"));
  assert.match(r.read("server/zz_generated_config.go"), /const configURLPath = ""/, "no runtime config for React");
  assert.deepEqual(r.read(".dockerignore").trim().split("\n"), ["node_modules", "dist", ".git", "coverage", ".env", ".env.*", "!.env.example", "*.pem", "*.key", ".distroless-backup"]);
  const rep = r.read("DISTROLESS-MIGRATION.md");
  assert.match(rep, /Setting `VITE_\*` on the running container does not change an already-built browser bundle\./);
  assert.match(rep, /`\.env\.production` is excluded from the build context/);
  assert.match(rep, /`vite preview` is a local preview server and is not used/);
  assert.match(rep, /writes nothing to disk at runtime/);
});

test("react generation: Create React App uses build/, REACT_APP_ analysis and the deprecation note", () => {
  const d = project({ "package.json": { ...CRA_PKG, homepage: "/portal" }, "yarn.lock": "", "public/index.html": "<title>%REACT_APP_NAME%</title>",
    "src/index.js": "const api = process.env.REACT_APP_API_URL;\nconst k = process.env.REACT_APP_SECRET_KEY;" });
  const r = cli(d, "react");
  assert.equal(r.code, 0, r.out);
  const df = r.read("Dockerfile");
  assert.match(df, /^RUN yarn install --frozen-lockfile$/m, "package manager detection is shared");
  assert.match(df, /^ARG REACT_APP_API_URL\nARG REACT_APP_NAME\nARG REACT_APP_SECRET_KEY\nRUN yarn run build$/m);
  assert.match(df, /\/app\/build \/app\/www$/m);
  const rep = r.read("DISTROLESS-MIGRATION.md");
  assert.match(rep, /Create React App is deprecated upstream/);
  assert.match(rep, /\| `REACT_APP_API_URL` \| CRA `REACT_APP_\*` \| `src\/index\.js:1` \|/);
  assert.match(rep, /1\. Move `REACT_APP_SECRET_KEY` out of the client build/, "credential-like variables come first");
  assert.match(rep, /## Base path[\s\S]*built for `\/portal\/` \(`homepage` in package\.json\)/);
  assert.match(rep, /Ingress strips the prefix/);
});

test("react generation: React Router ssr:false serves build/client; SSR aborts without writing", () => {
  const spa = project({ "package.json": RR_PKG, "package-lock.json": "{}", "react-router.config.ts": "export default { ssr: false };" });
  const ok = cli(spa, "react");
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.read("Dockerfile"), /^RUN npm run build$/m);
  assert.match(ok.read("Dockerfile"), /\/app\/build\/client \/app\/www$/m);
  assert.deepEqual(ok.read(".dockerignore").trim().split("\n").slice(0, 3), ["node_modules", "build", ".react-router"]);

  for (const cfg of [null, "export default { ssr: true };", "export default { ssr: process.env.SSR === '1' };"]) {
    const d = project({ "package.json": RR_PKG, ...(cfg ? { "react-router.config.ts": cfg } : {}) });
    const r = cli(d, "react");
    assert.equal(r.code, 1, `SSR config ${cfg} must not be served as static:\n${r.out}`);
    assert.match(r.out, /does not run React Router SSR/);
    assert.match(r.out, /set `ssr: false`/);
    assert.equal(r.read("Dockerfile"), null, "nothing is written when aborting");
  }
});

test("react generation: unknown builder uses the build script and an overridable output guess", () => {
  const pkg = { name: "wp", scripts: { build: "webpack --mode production" }, dependencies: { react: "19", "react-dom": "19" } };
  const d = project({ "package.json": pkg, "pnpm-lock.yaml": "", "public/index.html": "" });
  const r = cli(d);
  assert.equal(r.code, 0, r.out);
  assert.match(r.read("Dockerfile"), /^RUN pnpm run build$/m);
  assert.match(r.read("Dockerfile"), /\/app\/dist \/app\/www$/m);
  assert.doesNotMatch(r.out, /Vite/, "an unknown builder is never labelled Vite");
  assert.match(r.read("DISTROLESS-MIGRATION.md"), /was not read from your build configuration/);

  // An existing nginx Dockerfile tells us where the build output really is.
  const n = project({ "package.json": pkg, "public/index.html": "",
    Dockerfile: "FROM node:20 AS build\nWORKDIR /app\nRUN npm ci\nCOPY . .\nRUN npm run build\nFROM nginx:1.27\nCOPY --from=build /app/web /usr/share/nginx/html\nEXPOSE 80\n" });
  const rn = cli(n);
  assert.equal(rn.code, 0, rn.out);
  assert.match(rn.read("Dockerfile"), /^FROM node:20-trixie-slim AS build$/m, "node major from the old Dockerfile");
  assert.match(rn.read("Dockerfile"), /\/app\/web \/app\/www$/m);
  assert.match(rn.read("Dockerfile"), /^EXPOSE 8080$/m, "privileged port 80 becomes 8080");
});

test("react generation: nginx headers carried over, non-trivial nginx kept and reported", () => {
  const d = project({ "package.json": VITE_PKG, "index.html": "",
    "nginx.conf": "server {\n  listen 8081;\n  add_header X-Frame-Options DENY;\n  add_header Content-Security-Policy \"default-src 'self'\";\n  location / { try_files $uri /index.html; }\n  location /admin { auth_basic \"x\"; }\n}\n",
    "docker-entrypoint.sh": "#!/bin/sh\nenvsubst < /usr/share/nginx/html/env.tpl.js > /usr/share/nginx/html/env.js\nexec nginx -g 'daemon off;'\n" });
  const r = cli(d);
  assert.equal(r.code, 0, r.out);
  const go = r.read("server/zz_generated_config.go");
  assert.match(go, /\{"X-Frame-Options", "DENY"\}/);
  assert.match(go, /\{"Content-Security-Policy", "default-src 'self'"\}/);
  assert.match(r.read("Dockerfile"), /^EXPOSE 8081$/m, "nginx listen port reused");
  assert.ok(r.read("nginx.conf"), "nginx.conf with auth_basic is left in place by default");
  const rep = r.read("DISTROLESS-MIGRATION.md");
  assert.match(rep, /## Replaced nginx setup/);
  assert.match(rep, /nginx\.conf: uses 'auth_basic'/);
  assert.match(rep, /start-up file rewriting/);

  const proxy = project({ "package.json": VITE_PKG, "nginx.conf": "server { location /api { proxy_pass http://api:3000; } }" });
  const rp = cli(proxy);
  assert.equal(rp.code, 1, "proxy_pass can't be served statically: --yes aborts");
  assert.match(rp.out, /does NOT proxy/);
});

test("react stack refuses Next.js explicitly and points at the node stack", () => {
  const d = project({ "package.json": { dependencies: { next: "15", react: "19", "react-dom": "19" } } });
  const r = cli(d, "react");
  assert.equal(r.code, 1);
  assert.match(r.out, /Next\.js is handled by the node stack/);
  assert.equal(r.read("Dockerfile"), null);
});
