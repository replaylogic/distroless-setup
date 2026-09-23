// Unit tests for the parsers and analysis. Run with `npm test` (builds first).
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const files = require("../dist/core/files");
const docker = require("../dist/core/docker");
const an = require("../dist/stacks/angular/analysis");
const tpl = require("../dist/stacks/angular/templates");
const node = require("../dist/stacks/node");
const py = require("../dist/stacks/python");

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
  const go = tpl.renderGeneratedGo({ enabled: true, url: "/config.json", fields: [["k", "K", false]], override: null }, [["X-Test", 'a"b – c']]);
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
