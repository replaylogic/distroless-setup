/* Angular: static Go server on distroless/static + optional config.json runtime config. */
import * as fs from "fs";
import * as path from "path";
import { askImage, parseExistingDockerfile, reviewReferences, ExistingDockerfile } from "../../core/docker";
import { Plan, camelToEnv, exists, isDir, loadJson, readText, rel, tryJson, validPort, walkFiles } from "../../core/files";
import { askInstall, nodeMajorDefault } from "../../core/npm";
import { Prompter } from "../../core/prompt";
import { ActionItem, Ctx, MARKER, Stack, StackResult, mdCode, mdTable } from "../../core/report";
import { G, detail, fail, info, line, ok, panel, s, section, showDiff, warn } from "../../core/ui";
import {
  Obj, Reason, Unparsed, Usage, Val, applyRewrites, containsUnparsed, findBootstrapTarget, findConfigLoaders,
  flatJoin, flatten, isEnvModule, isPlainObj, parseEnvironmentFile, planProviderEdit, scanUsages, showValue, tsRelImport,
} from "./analysis";
import { GO_MOD, MAIN_GO } from "./go-server";
import { FILE_PREFIX, RuntimeConfig, renderDockerfile, renderGeneratedGo, renderTsModel, renderTsService } from "./templates";

const MIN_ANGULAR = 19;
const DEFAULT_HEADERS: [string, string][] = [
  ["X-Frame-Options", "SAMEORIGIN"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-XSS-Protection", "1; mode=block"],
  ["Referrer-Policy", "strict-origin-when-cross-origin"],
];
const RUNTIME_IMAGE = "gcr.io/distroless/static-debian13:nonroot";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

// ---- detection ------------------------------------------------------------------------
function angularVersion(repo: string): [number | null, string, string] {
  const inst = tryJson(path.join(repo, "node_modules/@angular/core/package.json"));
  const m1 = /^(\d+)/.exec(inst?.version ?? "");
  if (m1) return [+m1[1], inst.version, "installed"];
  const pkg = tryJson(path.join(repo, "package.json")) ?? {};
  for (const g of ["dependencies", "devDependencies", "peerDependencies"]) {
    const spec = pkg[g]?.["@angular/core"];
    if (spec) {
      const m = /(\d+)/.exec(spec);
      return [m ? +m[1] : null, spec, "package.json"];
    }
  }
  return [null, "unknown", "not found"];
}

async function angularGate(repo: string, P: Prompter): Promise<boolean> {
  const [major, shown, src] = angularVersion(repo);
  const good = major !== null && major >= MIN_ANGULAR;
  panel("Before we start", [[null, [
    `Angular support targets ${s("Angular " + MIN_ANGULAR + "+", "bold")} (standalone or NgModule apps).`,
    "nginx is replaced by a tiny static Go server on distroless/static. If the app",
    "has no runtime config yet, a config.json-driven config service is added and",
    "loaded through provideAppInitializer() (introduced in Angular 19).",
    "",
    `Detected @angular/core: ${s(shown, "cyan", "bold")} ${s("(" + src + ")", "gray")}`,
  ]]], good ? "cyan" : "yellow");
  if (good) {
    if (!(await P.confirm(`Continue with Angular ${major}?`, true))) fail("aborted: no files changed");
    return true;
  }
  warn(`Angular version ${major === null ? "could not be detected" : `is ${major}, below ${MIN_ANGULAR}`}. The runtime-config integration needs provideAppInitializer().`);
  const opts = ["Set up the distroless image only (no Angular code changes)", `Treat it as Angular ${MIN_ANGULAR}+ and continue anyway`, "Abort"];
  const pick = await P.choose("How do you want to proceed?", opts, 0);
  if (pick === 2) fail("aborted: no files changed");
  return pick === 1;
}

async function detectProject(repo: string, P: Prompter): Promise<[string, Json, Json]> {
  const ws = loadJson(path.join(repo, "angular.json"));
  if (exists(path.join(repo, "nx.json"))) warn("nx.json found. Nx workspaces may need a custom build command.");
  const apps = Object.entries<Json>(ws.projects ?? {}).filter(([, v]) => (v.projectType ?? "application") === "application");
  if (!apps.length) fail("no application projects found in angular.json");
  const names = apps.map(([k]) => k);
  const def = Math.max(0, names.indexOf(ws.defaultProject));
  const name = names[await P.choose("Which Angular project should the image serve?", names, def)];
  const conf = apps.find(([k]) => k === name)![1];
  const targets = conf.architect ?? conf.targets ?? {};
  return [name, targets.build ?? {}, conf];
}

function outputDir(project: string, build: Json, config: string): string {
  const opts = build.options ?? {};
  const cfg = build.configurations?.[config] ?? {};
  const op = cfg.outputPath ?? opts.outputPath ?? `dist/${project}`;
  let out: string;
  if (typeof op === "object") {
    const base = op.base ?? `dist/${project}`;
    const browser = op.browser ?? "browser";
    out = browser ? path.posix.join(base, browser) : base;
  } else {
    out = String(build.builder ?? "").endsWith(":application") ? path.posix.join(op, "browser") : op;
  }
  return path.posix.normalize(out.replace(/\\/g, "/"));
}

const isSsr = (build: Json, config: string) =>
  [build.options ?? {}, build.configurations?.[config] ?? {}].some((o: Json) => o.outputMode === "server" || o.ssr || o.server);

function findEntrypoints(repo: string): [string, [string, string][]][] {
  const res: [string, [string, string][]][] = [];
  const re = /"([\w.-]+)"\s*:\s*"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?/g;
  for (const p of walkFiles(repo, (f) => f.endsWith(".sh") || path.basename(f).startsWith("docker-entrypoint"))) {
    const text = readText(p);
    const pairs = [...text.matchAll(re)].map((m) => [m[1], m[2]] as [string, string]);
    if (pairs.length || text.includes("nginx")) res.push([p, pairs]);
  }
  return res;
}

function scanNginx(repo: string) {
  const files = [...walkFiles(repo, (f) => f.endsWith(".conf") && (f.toLowerCase().includes("nginx") || path.basename(f) === "default.conf"))];
  const r = { files, headers: [] as [string, string][], dynamic: [] as [string, string][], proxies: [] as string[], listen: null as string | null, other: [] as string[] };
  for (const f of files) {
    const t = readText(f).replace(/#[^\n]*/g, "");
    for (const m of t.matchAll(/\badd_header\s+([\w-]+)\s+("[^"]*"|'[^']*'|[^\s;]+)/g)) {
      let v = m[2];
      if (v.length >= 2 && v[0] === v[v.length - 1] && `"'`.includes(v[0])) v = v.slice(1, -1);
      if (["cache-control", "expires", "pragma"].includes(m[1].toLowerCase())) continue;
      (v.includes("$") ? r.dynamic : r.headers).push([m[1], v]);
    }
    for (const m of t.matchAll(/\bproxy_pass\s+[^;]+;/g)) r.proxies.push(`${path.basename(f)}: ${m[0].trim()}`);
    const l = /\blisten\s+(?:[\d.]+:)?(\d+)/.exec(t);
    if (l && !r.listen) r.listen = l[1];
    for (const kw of ["rewrite", "auth_basic", "limit_req", "sub_filter", "ssl_certificate", "return"])
      if (new RegExp(`(?:^|[;{}\\s])${kw}\\s`).test(t)) r.other.push(`${path.basename(f)}: uses '${kw}'`);
  }
  return r;
}

function findConfigFiles(repo: string): [string[], string[]] {
  const re = /^(app[-.]?)?(runtime[-.]?)?config(\.[\w-]+)?\.json$/i;
  const found: string[] = [];
  for (const base of ["src", "public"]) if (isDir(path.join(repo, base))) found.push(...walkFiles(path.join(repo, base), (f) => re.test(path.basename(f))));
  const dots = (f: string) => path.basename(f).split(".").length - 1;
  return [found.filter((f) => dots(f) === 1).sort(), found.filter((f) => dots(f) > 1).sort()];
}

function urlPathFor(repo: string, p: string) {
  const r = rel(repo, p);
  for (const pre of ["public/", "src/"]) if (r.startsWith(pre)) return "/" + r.slice(pre.length);
  return "/" + r;
}

// ---- build questions --------------------------------------------------------------------
async function gatherBuild(repo: string, P: Prompter, project: string, build: Json, existing: ExistingDockerfile) {
  section("Build stage");
  const pkg = tryJson(path.join(repo, "package.json")) ?? {};
  const install = await askInstall(repo, P, existing);
  const major = nodeMajorDefault(repo, existing, "22");
  const nodeImage = await P.ask("Node image for the build stage", `node:${major}-alpine`);
  const configs = Object.keys(build.configurations ?? {});
  const defCfg = build.defaultConfiguration ?? (configs.includes("production") ? "production" : configs[0] ?? "");
  let config = defCfg;
  let buildDef: string;
  const ng = `${install.pm.exec} ng`;
  if (existing.build) {
    const m = /--configuration[= ](\S+)|-c\s+(\S+)/.exec(existing.build);
    config = m ? m[1] ?? m[2] : defCfg;
    buildDef = existing.build;
  } else {
    if (configs.length) config = configs[await P.choose("Build configuration", configs, Math.max(0, configs.indexOf(defCfg)))];
    buildDef = `${ng} build` + (config ? ` --configuration=${config}` : "");
    if (pkg.scripts?.prebuild && (await P.confirm("package.json has a 'prebuild' script. Run it before ng build?", true)))
      buildDef = `${install.pm.run} prebuild && ${buildDef}`;
  }
  const buildCmd = await P.ask("Build command", buildDef);
  const m = /--configuration[= ](\S+)|-c\s+(\S+)/.exec(buildCmd);
  if (m) config = m[1] ?? m[2];
  if (isSsr(build, config)) {
    warn("SSR/server output is enabled for this project. This setup serves the static 'browser' output only; server-side rendering will NOT run.");
    if (!(await P.confirm("Continue with static-only serving?", false)))
      fail("aborted: SSR apps need a Node runtime; run `npx distroless-setup node` on the server bundle instead.");
  }
  const out = (await P.ask("Build output directory (contains index.html)", outputDir(project, build, config))).replace(/^\/+|\/+$/g, "");
  return { install, nodeImage, build: buildCmd, out, config };
}

function printFields(fields: [string, string, boolean][]) {
  line(`    ${s("JSON key", "bold").padEnd(32 + (s("", "bold").length))} ${s("<-", "gray")} ${s("ENV VAR", "bold")}   ${s("(json = parsed as raw JSON)", "gray")}`);
  for (const [k, e, raw] of fields.length ? fields : [["(none)", "", false] as [string, string, boolean]])
    line(`    ${k.padEnd(32)} ${s("<-", "gray")} ${s(e, "cyan")}${raw ? s("  (json)", "magenta") : ""}`);
}

function parseFieldLines(entered: string[]): [string, string, boolean][] {
  const out: [string, string, boolean][] = [];
  for (const l of entered) {
    const m = /^([^=\s]+)\s*=\s*([A-Z_][A-Z0-9_]*)(:json)?$/.exec(l);
    if (m) out.push([m[1], m[2], Boolean(m[3])]);
    else line(`    ${s("ignored invalid line: " + l, "red")}`);
  }
  return out;
}

interface Seed { url: string; baseRel: string; variants: [string, string][]; fields: [string, string, boolean][] }

async function gatherRuntimeConfig(repo: string, P: Prompter, entrypoints: [string, [string, string][]][], existing: ExistingDockerfile,
  seed: Seed | null, buildConfig: string): Promise<RuntimeConfig> {
  section("Runtime config (config.json from env vars)");
  if (seed) {
    info(`fields from the Angular integration, served at ${s(seed.url, "cyan")}`);
    const fields = seed.fields.map((f) => [...f] as [string, string, boolean]);
    const keys = new Set(fields.map((f) => f[0]));
    for (;;) {
      printFields(fields);
      if (await P.confirm("Use these env var names?", true)) break;
      for (const [k, e] of parseFieldLines(await P.lines("Rename as key=ENV_VAR (keys are fixed by the Angular interface)"))) {
        if (!keys.has(k)) { line(`    ${s("unknown key " + k + " ignored", "red")}`); continue; }
        for (const f of fields) if (f[0] === k) f[1] = e;
      }
    }
    const envs = fields.map((f) => f[1]);
    for (const d of new Set(envs.filter((e, i) => envs.indexOf(e) !== i))) warn(`env var ${d} feeds more than one key`);
    let override: string | null = null;
    if (seed.variants.length) {
      const opts = [`None (use ${seed.baseRel})`, ...seed.variants.map(([c, p]) => `${p}   (configuration '${c}')`)];
      const def = Math.max(0, seed.variants.findIndex(([c]) => c === buildConfig) + 1);
      const i = await P.choose("Copy an env-specific config over the default at Docker build time?", opts, def);
      override = i ? seed.variants[i - 1][1] : null;
    }
    return { enabled: true, url: seed.url, fields, override };
  }

  const [primary, variants] = findConfigFiles(repo);
  const epPairs = entrypoints.flatMap(([, p]) => p);
  if (primary.length) info("config files found: " + [...primary, ...variants].map((p) => rel(repo, p)).join(", "));
  if (epPairs.length) info(`entrypoint maps ${epPairs.length} env vars to config keys`);
  const disabled: RuntimeConfig = { enabled: false, url: "/config.json", fields: [], override: null };
  if (!(await P.confirm("Should the server render a config JSON from env vars at runtime?", Boolean(primary.length || epPairs.length)))) return disabled;
  const opts = [...primary.map((p) => rel(repo, p)), "Enter a path manually"];
  let choice = opts[await P.choose("Which file does the app fetch at startup?", opts, 0)];
  if (choice === "Enter a path manually") choice = await P.ask("Path to the config JSON in the repo", "public/config.json");
  const cfgPath = path.join(repo, choice);
  const url = await P.ask("URL path the browser requests it from", urlPathFor(repo, cfgPath), (v) => (v.startsWith("/") ? null : "must start with /"));
  let fields: [string, string, boolean][] = [];
  const seen = new Set<string>();
  for (const [k, e] of epPairs) if (!seen.has(k)) { fields.push([k, e, false]); seen.add(k); }
  const data = tryJson(cfgPath);
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries<Json>(data)) {
      if (seen.has(k)) { for (const f of fields) if (f[0] === k) f[2] = typeof v !== "string"; continue; }
      fields.push([k, camelToEnv(k), typeof v !== "string"]);
      seen.add(k);
    }
  } else if (exists(cfgPath)) warn(`could not parse ${choice}`);
  for (;;) {
    printFields(fields);
    if (fields.length && (await P.confirm("Use these fields?", true))) break;
    if (P.yes) { warn("no config fields found; runtime config disabled"); return disabled; }
    const parsed = parseFieldLines(await P.lines("Enter fields as key=ENV_VAR  (append :json for numbers/booleans/objects)"));
    if (parsed.length) fields = parsed;
    else if (!fields.length) { warn("no fields entered; runtime config disabled"); return disabled; }
    else if (await P.confirm("Nothing entered. Continue without runtime config?", false)) return disabled;
  }
  const vopts = ["None", ...variants.map((p) => rel(repo, p))];
  if (existing.override && !vopts.includes(existing.override)) vopts.push(existing.override);
  let override: string | null = null;
  if (vopts.length > 1) {
    const i = await P.choose("Copy an env-specific config over the default at build time?", vopts, Math.max(0, vopts.indexOf(existing.override ?? "None")));
    override = i ? vopts[i] : null;
  }
  return { enabled: true, url, fields, override };
}

function previousHeaders(repo: string): [[string, string][], string | null] {
  for (const d of walkFiles(repo, (f) => path.basename(f) === "zz_generated_config.go")) {
    const text = readText(d);
    const m = /var securityHeaders = \[\]\[2\]string\{([\s\S]*?)\n\}/.exec(text);
    if (/generated by distroless-setup/i.test(text) && m) {
      const pairs = [...m[1].matchAll(/\{("(?:[^"\\]|\\.)*"),\s*("(?:[^"\\]|\\.)*")\}/g)].map((x) => [JSON.parse(x[1]), JSON.parse(x[2])] as [string, string]);
      return [pairs, d];
    }
  }
  return [[], null];
}

async function gatherHeaders(repo: string, P: Prompter, nginx: ReturnType<typeof scanNginx>): Promise<[string, string][]> {
  section("Security headers");
  let headers = new Map(DEFAULT_HEADERS);
  const [prev, gen] = previousHeaders(repo);
  if (prev.length) { info(`using headers from the previous run (${rel(repo, gen!)})`); headers = new Map(prev); }
  for (const [n, v] of nginx.headers) headers.set(n, v);
  for (const [n, v] of nginx.dynamic) warn(`header '${n}: ${v}' uses nginx variables and can't be ported; add it manually if needed`);
  for (;;) {
    for (const [n, v] of headers) line(`     ${n}: ${v}`);
    if (await P.confirm("Send these headers on every response?", true)) return [...headers];
    const next = new Map<string, string>();
    for (const l of await P.lines("Enter headers as 'Name: value'")) {
      const i = l.indexOf(":");
      if (i > 0 && /^[A-Za-z0-9-]+$/.test(l.slice(0, i).trim())) next.set(l.slice(0, i).trim(), l.slice(i + 1).trim());
      else line(`    ${s("ignored invalid line: " + l, "red")}`);
    }
    headers = next;
  }
}

// ---- Angular runtime-config integration -------------------------------------------------
interface NgResult {
  seed: Seed; source: string; mode: "flat" | "raw"; kept: string[]; skipped: [string, string][];
  keyRows: [string, string][]; runtimeObj: Obj; variantNotes: string[]; baseRel: string; url: string;
  model: string; service: string; wiring: { target: string | null; status: string; snippetImport: string | null; diff: string[] };
  usages: Usage[]; rewriteDone: boolean; specFollow: string[]; envFiles: string[];
}

function envFiles(repo: string, build: Json, srcRoot: string): [string | null, Map<string, string>, string[]] {
  let base: string | null = null;
  const perCfg = new Map<string, string>();
  for (const [cfg, opts] of Object.entries<Json>(build.configurations ?? {}))
    for (const fr of opts?.fileReplacements ?? []) {
      if (isEnvModule(path.basename(String(fr.replace ?? ""), ".ts"))) {
        base ??= path.join(repo, fr.replace);
        perCfg.set(cfg, path.join(repo, fr.with));
      }
    }
  const dir = path.join(srcRoot, "environments");
  const found = isDir(dir) ? [...walkFiles(dir, (f) => /^environment.*\.ts$/.test(path.basename(f)))] : [];
  if (!base) base = exists(path.join(dir, "environment.ts")) ? path.join(dir, "environment.ts") : found[0] ?? null;
  return [base, perCfg, found];
}

function publicDir(repo: string, build: Json): string | null {
  for (const a of build.options?.assets ?? []) {
    const inp = typeof a === "object" ? a.input : a;
    if (typeof inp === "string" && inp.replace(/\/+$/, "").split("/").pop() === "public") return path.join(repo, inp.replace(/\/+$/, ""));
  }
  return null;
}

const REASONS: Record<Reason, [string, string]> = {
  eager: ["Evaluated when the module loads, before config.json has been fetched.",
    "Move the read into a function, method or factory that runs after bootstrap, e.g. `() => runtimeConfig().x`, or keep this key build-time."],
  bootstrap: ["In the bootstrap config; these providers are built before app initializers finish.",
    "Use a factory provider, e.g. `{ provide: TOKEN, useFactory: () => runtimeConfig().x }`, if it is first injected after bootstrap. If an initializer needs it, have that initializer `await inject(RuntimeConfigService).load()` first. Otherwise keep the key build-time."],
  whole: ["Uses the environment object as a whole (passed, spread, destructured or bracket-accessed).", "Replace with explicit reads of the keys needed from `runtimeConfig()`."],
  "flat-parent": ["Reads a nested object that was flattened into separate keys.", "Read the individual flattened keys instead (see the key mapping table)."],
  unknown: ["The key is not in the environment file (typo, or added elsewhere).", "Check the key name against the environment file."],
  spec: ["Unit test; not rewritten automatically.", "If the code under test now reads `runtimeConfig()`, call `setRuntimeConfigForTesting({ ... })` in `beforeEach`."],
};

async function gatherAngular(repo: string, P: Prompter, plan: Plan, projectConf: Json, build: Json): Promise<NgResult | null> {
  section("Angular runtime config");
  const srcRoot = path.join(repo, projectConf.sourceRoot ?? "src");
  const tsFiles = [...walkFiles(srcRoot, (f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))];
  const ours = tsFiles.filter((f) => path.basename(f) === `${FILE_PREFIX}.service.ts` && readText(f).includes(MARKER));
  if (ours.length) info(`previous setup found (${rel(repo, ours[0])}); it will be regenerated`);
  else {
    const loaders = findConfigLoaders(tsFiles, repo, FILE_PREFIX);
    if (loaders.length) {
      info("the app already appears to load a config JSON at runtime:");
      loaders.slice(0, 8).forEach((h) => detail(h));
      if (await P.confirm("Keep the existing mechanism and skip the Angular changes?", true)) return null;
    }
  }

  let [baseEnv, perCfg, found] = envFiles(repo, build, srcRoot);
  if (baseEnv && !exists(baseEnv)) { warn(`${rel(repo, baseEnv)} is referenced in angular.json but does not exist`); baseEnv = null; }
  info("environment files: " + (found.map((f) => rel(repo, f)).join(", ") || "none found"));
  const sources = [...(baseEnv ? [`Use my environment files (base: ${rel(repo, baseEnv)})`] : []), "Enter the config keys myself"];
  const fromEnv = Boolean(baseEnv) && (await P.choose("Where should the runtime config keys come from?", sources, 0)) === 0;

  let baseObj: Obj = {};
  const skipped: [string, Val][] = [];
  const variantValues = new Map<string, [string, Obj]>();
  if (fromEnv && baseEnv) {
    const [exportName, obj] = parseEnvironmentFile(baseEnv);
    if (!obj) warn(`no \`export const ... = {...}\` object literal found in ${rel(repo, baseEnv)}`);
    if (exportName && exportName !== "environment") info(`the environment object is exported as '${exportName}'`);
    for (const [k, v] of Object.entries(obj ?? {})) (containsUnparsed(v) ? skipped.push([k, v]) : (baseObj[k] = v));
    for (const [cfg, f] of perCfg) {
      if (!exists(f)) { warn(`configuration '${cfg}' replaces with ${rel(repo, f)}, which does not exist`); continue; }
      if (f !== baseEnv) variantValues.set(cfg, [f, parseEnvironmentFile(f)[1] ?? {}]);
    }
    line(`    ${s("key".padEnd(30), "bold")} ${s("value (" + rel(repo, baseEnv) + ")", "bold")}`);
    for (const [k, v] of Object.entries(baseObj)) line(`    ${k.padEnd(30)} ${s(showValue(v, 48, G.ell), "cyan")}`);
    for (const [k, v] of skipped) line(`    ${s(k.padEnd(30), "gray")} ${s(showValue(v, 40, G.ell) + "  skipped: not a plain value", "yellow")}`);
  } else {
    for (const l of await P.lines("Enter keys as key=default  (default parsed as JSON when possible, else a string)")) {
      const i = l.indexOf("=");
      const k = (i < 0 ? l : l.slice(0, i)).trim();
      const v = i < 0 ? "" : l.slice(i + 1).trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(k)) { line(`    ${s("ignored invalid key: " + l, "red")}`); continue; }
      try { baseObj[k] = v ? JSON.parse(v) : ""; } catch { baseObj[k] = v; }
    }
  }
  if (!Object.keys(baseObj).length) { warn("no usable config keys; skipping the Angular integration"); return null; }

  const keys = Object.keys(baseObj);
  const keepIdx = await P.multi("Which keys should STAY build-time in environment.ts (not moved to config.json)?",
    keys.map((k) => `${k.padEnd(28)} ${s(showValue(baseObj[k], 40, G.ell), "gray")}`), keys.flatMap((k, i) => (k === "production" ? [i] : [])));
  const kept = new Set(keepIdx.map((i) => keys[i]));
  const moved: Obj = Object.fromEntries(Object.entries(baseObj).filter(([k]) => !kept.has(k)));
  if (!Object.keys(moved).length) { warn("every key stays build-time; skipping the Angular integration"); return null; }

  const nested = Object.entries(moved).filter(([, v]) => isPlainObj(v) && Object.keys(v).length).map(([k]) => k);
  let mode: "flat" | "raw" = "flat";
  if (nested.length) {
    info("nested objects: " + nested.join(", "));
    mode = (await P.choose("How should nested objects be handled?", [
      "Flatten into separate keys, one env var per value (e.g. auth.clientId -> authClientId / AUTH_CLIENT_ID)",
      "Keep each object as one key, set as a JSON string env var (e.g. AUTH='{\"clientId\":\"...\"}')",
    ], 0)) === 0 ? "flat" : "raw";
  }
  const shape = (o: Obj): Obj => (mode === "raw" ? { ...o } : Object.fromEntries(flatten(o).map(([p, v]) => [flatJoin(p), v])));
  const flatMap = new Map<string, string>();
  if (mode === "flat") for (const [p] of flatten(moved)) {
    const flat = flatJoin(p);
    if ([...flatMap.values()].includes(flat)) warn(`flattened key '${flat}' collides; rename one of the source keys`);
    flatMap.set(p.join("."), flat);
  }
  const runtimeObj = shape(moved);

  const pub = publicDir(repo, build);
  if (!pub) warn("no 'public' assets folder in angular.json; make sure the config file path below is served");
  const baseRel = await P.ask("Base config file (bundled into the build)", rel(repo, path.join(pub ?? path.join(repo, "public"), "config.json")),
    (v) => (v.endsWith(".json") ? null : "must be a .json file"));
  const url = await P.ask("URL path the browser requests it from", urlPathFor(repo, path.join(repo, baseRel)), (v) => (v.startsWith("/") ? null : "must start with /"));
  const variants: [string, string][] = [];
  const variantNotes: string[] = [];
  if (variantValues.size) {
    const vdir = await P.ask("Folder for per-configuration config files (not bundled; copied by the Dockerfile)", "runtime-config",
      (v) => (/^[\w./-]+$/.test(v) && !v.startsWith("/") ? null : "use a relative path"));
    for (const [cfg, [f, obj]] of [...variantValues].sort()) {
      const values: Obj = {};
      for (const k of Object.keys(moved)) {
        if (k in obj && !containsUnparsed(obj[k])) values[k] = obj[k];
        else {
          values[k] = moved[k];
          variantNotes.push(`\`${k}\` in ${rel(repo, f)} ${k in obj ? "is not a plain value" : "is missing"}; config.${cfg}.json uses the base value`);
        }
      }
      const vp = `${vdir.replace(/\/+$/, "")}/config.${cfg}.json`;
      variants.push([cfg, vp]);
      plan.write(path.join(repo, vp), JSON.stringify(shape(values), null, 2) + "\n", `config for '${cfg}' (from ${path.basename(f)})`);
    }
  }
  plan.write(path.join(repo, baseRel), JSON.stringify(runtimeObj, null, 2) + "\n", fromEnv && baseEnv ? `runtime config (from ${path.basename(baseEnv)})` : "runtime config");

  const svcDir = path.join(repo, await P.ask("Folder for the generated config service", rel(repo, path.join(srcRoot, "app/core/config"))));
  const modelFile = path.join(svcDir, `${FILE_PREFIX}.model.ts`);
  const serviceFile = path.join(svcDir, `${FILE_PREFIX}.service.ts`);
  for (const f of [modelFile, serviceFile])
    if (exists(f) && !readText(f).includes(MARKER)) {
      warn(`${rel(repo, f)} exists and was not generated by this tool`);
      if (!(await P.confirm("Overwrite it (a backup is kept)?", false))) fail("aborted: choose a different folder for the config service");
    }
  plan.write(modelFile, renderTsModel(runtimeObj, url), "RuntimeConfig interface + keys");
  plan.write(serviceFile, renderTsService(), "config loader, provideRuntimeConfig()");

  const buildOpts = (projectConf.architect ?? projectConf.targets ?? {}).build?.options ?? {};
  const mainTs = [buildOpts.browser, buildOpts.main, rel(repo, path.join(srcRoot, "main.ts"))].find((c) => c && exists(path.join(repo, c)));
  const bt = findBootstrapTarget(mainTs ? path.join(repo, mainTs) : null);
  const wiring = { target: bt.target ? rel(repo, bt.target) : null, status: "not-found", snippetImport: null as string | null, diff: [] as string[] };
  if (bt.target) {
    const [text, status] = planProviderEdit(bt.target, serviceFile, "loads the runtime config before bootstrap");
    wiring.status = status;
    wiring.snippetImport = `import { provideRuntimeConfig } from '${tsRelImport(bt.target, serviceFile)}';`;
    if (status === "edited") {
      line(`  Proposed change to ${s(rel(repo, bt.target), "bold")}:`);
      wiring.diff = showDiff(readText(bt.target), text, rel(repo, bt.target));
      if (await P.confirm(`Apply this change to ${path.basename(bt.target)}?`, true)) plan.write(bt.target, text, "register provideRuntimeConfig()");
      else wiring.status = "declined";
    } else if (status === "present") ok(`${rel(repo, bt.target)} already registers provideRuntimeConfig()`);
    else warn(`no \`providers: [...]\` array found in ${rel(repo, bt.target)}; the report has the snippet`);
  } else warn("could not locate the bootstrap config (app.config.ts); the report has the snippet");

  const envSet = new Set([...found, ...perCfg.values(), ...(baseEnv ? [baseEnv] : [])]);
  const { usages, edits } = scanUsages({
    repo, files: tsFiles.filter((f) => !envSet.has(f) && !path.basename(f).startsWith(FILE_PREFIX)),
    moved: new Set(Object.keys(moved)), kept: new Set([...kept, ...skipped.map(([k]) => k)]),
    flatMap: mode === "flat" ? flatMap : null, flattenedParents: new Set(mode === "flat" ? nested : []),
    bootstrapFiles: new Set([bt.target, bt.main].filter((x): x is string => Boolean(x))),
  });
  const count = (st: string) => usages.filter((u) => u.status === st).length;
  const filesRw = new Set(usages.filter((u) => u.status === "rewritable").map((u) => u.file));
  info(`environment reads found: ${usages.length}  (${s(count("rewritable") + " safe to rewrite", "green")}, ${s(count("manual") + " need manual changes", "yellow")}, ${count("build-time")} build-time)`);
  let rewriteDone = false;
  if (count("rewritable")) {
    const pick = await P.choose("Update environment reads?", [
      `Rewrite the ${count("rewritable")} safe reads in ${filesRw.size} file(s) to runtimeConfig() (backed up)`,
      "Don't change code; list everything in the report",
    ], 0);
    if (pick === 0) {
      for (const [f, e] of edits) {
        if (plan.pending(f) !== null) continue; // already edited above; stay safe
        plan.write(f, applyRewrites(readText(f), e, serviceFile, f), `${e.length} env read(s) -> runtimeConfig()`);
      }
      rewriteDone = true;
    }
  }
  for (const u of usages) if (u.status === "rewritable") u.status = rewriteDone ? "rewritten" : "to-rewrite";
  const specFollow = rewriteDone ? [...edits.keys()].map((f) => f.replace(/\.ts$/, ".spec.ts")).filter(exists).map((f) => rel(repo, f)) : [];
  const keyRows: [string, string][] = mode === "flat" ? [...flatMap] : Object.keys(runtimeObj).map((k) => [k, k]);

  return {
    seed: { url, baseRel, variants, fields: Object.entries(runtimeObj).map(([k, v]) => [k, camelToEnv(k), typeof v !== "string"]) },
    source: fromEnv && baseEnv ? rel(repo, baseEnv) : "entered manually", mode, kept: [...kept].sort(),
    skipped: skipped.map(([k, v]) => [k, v instanceof Unparsed ? v.raw : showValue(v)]), keyRows, runtimeObj, variantNotes,
    baseRel, url, model: rel(repo, modelFile), service: rel(repo, serviceFile), wiring, usages, rewriteDone, specFollow,
    envFiles: [...envSet].filter(exists).map((f) => rel(repo, f)).sort(),
  };
}

function ngActions(ng: NgResult | null, rc: RuntimeConfig): ActionItem[] {
  const items: ActionItem[] = [];
  if (ng) {
    const w = ng.wiring;
    if (["no-providers", "not-found", "declined"].includes(w.status))
      items.push({ short: `Register provideRuntimeConfig() in ${w.target ?? "app.config.ts"}`,
        md: `Register the config loader in ${w.target ? `\`${w.target}\`` : "your bootstrap config (app.config.ts)"}: add \`${w.snippetImport ?? `import { provideRuntimeConfig } from './${ng.service.replace(/\.ts$/, "")}';`}\` and put \`provideRuntimeConfig()\` first in the \`providers\` array. See [Angular wiring](#angular-wiring).` });
    const manual = ng.usages.filter((u) => u.status === "manual");
    if (manual.length) items.push({ short: `Fix ${manual.length} environment read(s) that can't be switched automatically`,
      md: `Fix ${manual.length} environment read(s) that couldn't be switched automatically. Each is listed with the reason and a suggested fix under [Needs manual changes](#needs-manual-changes).` });
    const todo = ng.usages.filter((u) => u.status === "to-rewrite");
    if (todo.length) items.push({ short: `Switch ${todo.length} environment read(s) to runtimeConfig()`,
      md: `Switch ${todo.length} environment read(s) in ${new Set(todo.map((u) => u.file)).size} file(s) to \`runtimeConfig()\` (import it from \`${ng.service.replace(/\.ts$/, "")}\`). They are safe to change; see [Safe to switch](#safe-to-switch).` });
    if (ng.specFollow.length || todo.length || manual.length)
      items.push({ short: "Update unit tests: setRuntimeConfigForTesting() in beforeEach",
        md: `Update unit tests. Code that reads \`runtimeConfig()\` throws until a config is set, and app initializers don't run under TestBed. Call \`setRuntimeConfigForTesting({ ... })\` in \`beforeEach\` for ${ng.specFollow.map((f) => `\`${f}\``).join(", ") || "any spec that exercises the changed code"}.` });
    items.push({ short: "Other app initializers that need config: await load() first",
      md: "If another app initializer reads config values, make it `await inject(RuntimeConfigService).load()` first. Angular runs initializers in parallel, and `load()` is memoised, so this doesn't fetch twice." });
    items.push({ short: "Remove moved keys from environment*.ts once nothing reads them",
      md: `Once no code reads the moved keys from \`environment\`, remove them from ${ng.envFiles.map((f) => `\`${f}\``).join(", ")}. Keep the build-time keys (${ng.kept.map((k) => `\`${k}\``).join(", ") || "none"}).` });
  }
  if (rc.enabled && rc.fields.length)
    items.push({ short: "Add USE_RUNTIME_CONFIG=true and the config env vars to your deployment",
      md: "Add `USE_RUNTIME_CONFIG=true` and the env vars you want to override to your deployment manifests (Compose, Helm values, ConfigMaps). Any variable you leave unset keeps its build-time value." });
  return items;
}

function ngSections(ng: NgResult | null, rc: RuntimeConfig): string[] {
  const out: string[] = [];
  if (rc.enabled) {
    const L = ["## Runtime config", "", `The app fetches \`${rc.url}\` before it bootstraps. In the container, the Go server serves it:`, "",
      "- `USE_RUNTIME_CONFIG` unset: the file baked into the image is served as-is.",
      "- `USE_RUNTIME_CONFIG=true`: each key whose env var is set takes the env value; keys whose env var is unset keep their build-time value. Nothing is written to disk.",
      "- To change a value after deployment, set or change its env var and restart the container.", ""];
    const envOf = new Map(rc.fields.map(([k, e]) => [k, e]));
    const rawOf = new Map(rc.fields.map(([k, , r]) => [k, r]));
    if (ng) {
      L.push(`Source: ${ng.source}. Nested objects: ${ng.mode === "flat" ? "flattened into separate keys" : "kept as JSON-valued keys"}.`, "",
        mdTable(["environment key", "config.json key", "Env var", "Type"], ng.keyRows.map(([src, dst]) => [`\`${src}\``, `\`${dst}\``, `\`${envOf.get(dst) ?? "?"}\``, rawOf.get(dst) ? "JSON" : "string"])), "",
        `- Base file (bundled): \`${ng.baseRel}\``, ...ng.seed.variants.map(([c, p]) => `- Configuration \`${c}\`: \`${p}\``),
        ...(rc.override ? [`- The Dockerfile copies \`${rc.override}\` over the base file at build time.`] : []), "");
      if (ng.kept.length) L.push("Kept build-time (still read from `environment`): " + ng.kept.map((k) => `\`${k}\``).join(", ") + ".", "");
      if (ng.skipped.length) L.push("Not moved because the value isn't a plain literal (it stays in `environment`):", "", ...ng.skipped.map(([k, v]) => `- \`${k}\` = ${mdCode(v)}`), "");
      if (ng.variantNotes.length) L.push("Notes on per-configuration files:", "", ...ng.variantNotes.map((n) => `- ${n}`), "");
    } else {
      L.push(mdTable(["config.json key", "Env var", "Type"], rc.fields.map(([k, e, r]) => [`\`${k}\``, `\`${e}\``, r ? "JSON" : "string"])), "");
    }
    out.push(L.join("\n"));
  }
  if (ng) {
    const w = ng.wiring;
    const L = ["## Angular wiring", "", `Generated \`${ng.model}\` (the \`RuntimeConfig\` interface) and \`${ng.service}\`, which exports:`, "",
      "- `provideRuntimeConfig()`: registers an app initializer that fetches the config before bootstrap.",
      "- `runtimeConfig()`: returns the loaded config. Works in any code that runs after bootstrap.",
      "- `RuntimeConfigService`: the same through DI (`config`, `get(key)`, `load()`).",
      "- `setRuntimeConfigForTesting(cfg)`: sets the config in unit tests.", "",
      "The service uses `fetch()`, so HTTP interceptors never see the config request.", ""];
    const status: Record<string, string> = {
      edited: `\`provideRuntimeConfig()\` was added to \`${w.target}\`:`,
      present: `\`${w.target}\` already registers \`provideRuntimeConfig()\`.`,
      declined: `You chose not to edit \`${w.target}\`. Add this yourself:`,
      "no-providers": `No \`providers: [...]\` array was found in \`${w.target}\`. Add this yourself:`,
      "not-found": "The bootstrap config wasn't found. Add this to the `providers` of your `ApplicationConfig` (or root `@NgModule`):",
    };
    L.push(status[w.status], "");
    if (w.status === "edited" && w.diff.length) L.push("```diff", ...w.diff, "```", "");
    else if (w.status !== "present")
      L.push("```ts", w.snippetImport ?? `import { provideRuntimeConfig } from './${ng.service.replace(/\.ts$/, "")}';`, "", "providers: [", "  provideRuntimeConfig(),", "  // ...your other providers", "],", "```", "");
    L.push("## Environment reads", "");
    const table = (us: Usage[]) => mdTable(["Location", "Key", "Code"], us.map((u) => [`\`${u.file}:${u.line}\``, `\`${u.key}\``, mdCode(u.code.slice(0, 100))]));
    for (const [st, title] of [["rewritten", "Switched to runtimeConfig()"], ["to-rewrite", "Safe to switch"], ["manual", "Needs manual changes"], ["build-time", "Build-time (unchanged)"]] as const) {
      const us = ng.usages.filter((u) => u.status === st);
      if (!us.length) continue;
      L.push(`### ${title}`, "");
      if (st === "manual") {
        for (const r of Object.keys(REASONS) as Reason[]) {
          const rs = us.filter((u) => u.reason === r);
          if (rs.length) L.push(`**${REASONS[r][0]}** ${REASONS[r][1]}`, "", table(rs), "");
        }
      } else {
        if (st === "to-rewrite") L.push(`These run after bootstrap, so replacing \`environment.\` with \`runtimeConfig().\`${ng.mode === "flat" ? " (using the flattened key names above)" : ""} is safe. Re-run and choose *Rewrite* to do it automatically.`, "");
        L.push(table(us), "");
      }
    }
    if (!ng.usages.length) L.push("No `environment` imports were found.", "");
    L.push("How reads are classified: the TypeScript syntax tree is checked for whether a read sits inside a function, method, constructor, instance field or arrow function (runs after bootstrap), or at module level, in a decorator or a static field (runs when the module loads). A class created *during* app initialisation, e.g. a service injected by another initializer, can still read too early.", "");
    out.push(L.join("\n"));
  }
  return out;
}

// ---- stack ------------------------------------------------------------------------------
export const angularStack: Stack = {
  id: "angular",
  title: "Angular",
  detect(repo) {
    if (!exists(path.join(repo, "angular.json"))) return null;
    return { score: 1, reason: "angular.json" };
  },
  async run(ctx: Ctx): Promise<StackResult> {
    const { repo, P, plan } = ctx;
    section("Scanning repo");
    const angularOk = await angularGate(repo, P);
    const [project, build, projectConf] = await detectProject(repo, P);
    const dockerfile = path.join(repo, "Dockerfile");
    const existing = parseExistingDockerfile(dockerfile);
    const nginx = scanNginx(repo);
    const entrypoints = findEntrypoints(repo);
    info(`project: ${s(project, "bold")}`);
    if (exists(dockerfile)) info("existing Dockerfile found (will be backed up and replaced)");
    for (const f of nginx.files) info(`nginx config: ${rel(repo, f)}`);
    for (const [p] of entrypoints) info(`entrypoint/shell script: ${rel(repo, p)}`);
    if (nginx.proxies.length) {
      warn("nginx reverse-proxies requests. The static server does NOT proxy:");
      nginx.proxies.forEach((p) => detail(p));
      line("    Move API routing to your ingress/gateway, or call APIs directly via runtime config URLs.");
      if (!(await P.confirm("Continue anyway?", false))) fail("aborted: proxy_pass needs a different solution first");
    }
    for (const o of nginx.other) warn(`${o} - not ported; review manually`);

    const b = await gatherBuild(repo, P, project, build, existing);
    const ng = angularOk ? await gatherAngular(repo, P, plan, projectConf, build) : null;
    const rc = await gatherRuntimeConfig(repo, P, entrypoints, existing, ng?.seed ?? null, b.config);
    const headers = await gatherHeaders(repo, P, nginx);

    section("Runtime image");
    const prev = [existing.port, nginx.listen].filter((p): p is string => Boolean(p));
    const portDef = prev.find((p) => !validPort(p)) ?? "8080";
    const priv = prev.find((p) => validPort(p));
    if (priv) info(`previous port ${priv} is privileged; non-root needs >=1024, defaulting to ${portDef}`);
    const port = await P.ask("Container port", portDef, validPort);
    const image = await askImage(P, "Runtime base image", RUNTIME_IMAGE);
    const goImage = await P.ask("Go builder image (Go 1.24+)", "golang:1-alpine");

    section("Server source location");
    let serverDef = "server";
    if (exists(path.join(repo, "server")) && !exists(path.join(repo, "server/zz_generated_config.go"))) {
      warn("a 'server/' directory already exists and wasn't created by this tool");
      serverDef = "distroless-server";
    }
    const serverDir = await P.ask("Directory for the Go server source", serverDef, (v) => (/^[A-Za-z0-9._-]+$/.test(v) ? null : "use a simple folder name"));
    const sd = path.join(repo, serverDir);
    if (isDir(sd) && !exists(path.join(sd, "zz_generated_config.go")) && fs.readdirSync(sd).length)
      if (!(await P.confirm(`'${serverDir}/' is not empty. Write files into it anyway?`, false))) fail("aborted: choose a different server directory");

    plan.write(dockerfile, renderDockerfile({ nodeImage: b.nodeImage, install: b.install, build: b.build, out: b.out, rc, goImage, image, port, serverDir }), "3-stage distroless build");
    plan.write(path.join(sd, "main.go"), MAIN_GO, "static file server");
    plan.write(path.join(sd, "go.mod"), GO_MOD, "Go module");
    plan.write(path.join(sd, "zz_generated_config.go"), renderGeneratedGo(rc, headers), "config fields + headers");

    section("Cleanup of files the new approach replaces");
    const candidates = [...new Set([...nginx.files, ...entrypoints.filter(([p]) => path.basename(p).startsWith("docker-entrypoint") || readText(p).includes("nginx")).map(([p]) => p)])];
    if (candidates.length) {
      candidates.forEach((c) => info(rel(repo, c)));
      if (await P.confirm("Remove these (backed up first)?", true)) candidates.forEach((c) => plan.remove(c, "replaced by the static server"));
    } else info("nothing to clean up");

    const needed = ["package.json", "angular.json", ...(b.install.pm.lock ? [b.install.pm.lock] : []), ...b.install.extras.map((e) => e.replace(/\/+$/, "")),
      `${serverDir}/main.go`, `${serverDir}/go.mod`, `${serverDir}/zz_generated_config.go`, ...(rc.enabled && rc.override ? [rc.override] : []),
      ...(ng ? [ng.service, ng.model, ng.baseRel] : [])];
    const facts = [
      rc.enabled ? `${s(G.ok, "green")} ${rc.url} with ${rc.fields.length} field(s)${rc.override ? `, override ${rc.override}` : ""}` : `${s(G.bullet, "gray")} runtime config disabled`,
    ];
    if (ng) {
      const st = new Map<string, number>();
      for (const u of ng.usages) st.set(u.status, (st.get(u.status) ?? 0) + 1);
      const wired = ["edited", "present"].includes(ng.wiring.status);
      facts.push(`${wired ? s(G.ok, "green") : s(G.warn, "yellow")} provideRuntimeConfig() ${wired ? "registered" : "NOT registered"}`,
        `${s(G.bullet, "gray")} environment reads: ${[...st].sort().map(([k, v]) => `${v} ${k}`).join(", ") || "none"}`);
    }
    return {
      stack: "Angular", imageName: project, port, runtimeImage: image,
      summary: [`Build: \`${b.build}\``, `Build output: \`${b.out}\``,
        `Runtime config: ${rc.enabled ? `\`${rc.url}\`, ${rc.fields.length} field(s)` : "disabled"}`, `Angular integration: ${ng ? "added" : "not changed"}`],
      consoleFacts: facts, actions: ngActions(ng, rc), sections: ngSections(ng, rc),
      runEnv: rc.enabled && rc.fields.length ? ["-e USE_RUNTIME_CONFIG=true", ...rc.fields.slice(0, 6).map(([, e]) => `-e ${e}=...`)] : [],
      verify: [`curl -s  http://localhost:${port}${rc.url}`, `curl -sI http://localhost:${port}/some/deep/route    # 200, SPA fallback`,
        `curl -sI -H 'Accept-Encoding: gzip' http://localhost:${port}/   # Content-Encoding: gzip`],
      // The build stage does `COPY . .`, so local secrets must be kept out of the build context.
      dockerignoreRecommended: ["node_modules", "dist", ".angular", ".git", "coverage", ".env", ".env.*", "!.env.example", "*.pem"],
      dockerignoreNeeded: needed,
      reviewHits: reviewReferences(repo, new Set(candidates)), healthPath: "/healthz",
      // The Go server renders the config in memory and pre-compresses into memory.
      writablePaths: [],
    };
  },
};
