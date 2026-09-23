/* React: static analysis of package.json, vite.config / react-router.config and client
   source. Nothing here executes project code; a value that isn't a literal is "dynamic". */
import * as path from "path";
import * as ts from "typescript";
import { exists, readText, rel, walkFiles } from "../../core/files";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

export type Builder = "vite" | "react-router" | "cra" | "generic";

export const BUILDER_LABEL: Record<Builder, string> = {
  vite: "React + Vite",
  "react-router": "React Router (framework, SPA mode)",
  cra: "Create React App",
  generic: "React (unrecognised builder)",
};

const CONFIG_EXT = ["ts", "mts", "cts", "js", "mjs", "cjs"];
const SERVER_FW = ["express", "fastify", "koa", "hono", "@nestjs/core"];

export function deps(pkg: Json): Record<string, string> {
  return { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
}

export const hasReact = (d: Record<string, string>) => Boolean(d.react || d["react-dom"]);
export const serverFramework = (d: Record<string, string>) => SERVER_FW.find((f) => d[f]) ?? null;

/** React frameworks whose deployment isn't a plain static build. Next.js belongs to the node stack. */
export function otherFramework(d: Record<string, string>): "next" | "remix" | "gatsby" | null {
  if (d.next) return "next";
  if (Object.keys(d).some((k) => k.startsWith("@remix-run/"))) return "remix";
  if (d.gatsby) return "gatsby";
  return null;
}

export function configFile(repo: string, base: string): string | null {
  for (const ext of CONFIG_EXT) {
    const f = path.join(repo, `${base}.${ext}`);
    if (exists(f)) return f;
  }
  return null;
}

export function classify(repo: string, pkg: Json): Builder {
  const d = deps(pkg);
  const build = String(pkg.scripts?.build ?? "");
  if (d["@react-router/dev"]) return "react-router";
  if (d.vite || configFile(repo, "vite.config") || /\bvite\s+build\b/.test(build)) return "vite";
  if (d["react-scripts"]) return "cra";
  return "generic";
}

// ---- config files ---------------------------------------------------------------------------

export type ConfigValue = { kind: "literal"; value: string | boolean } | { kind: "dynamic" };

/**
 * Reads properties of the exported config object without running it. Only properties of
 * the outermost object literals count (`defineConfig({...})`, `export default {...}`, or the
 * object an arrow function returns), plus `build.<key>` for `build.` prefixed keys; the
 * same name inside plugin options is ignored. A key set to anything but a string/boolean
 * literal, or set to different literals in different branches, is "dynamic".
 */
export function readConfig(file: string, keys: string[]): Map<string, ConfigValue> {
  const out = new Map<string, ConfigValue>();
  const sf = ts.createSourceFile(file, readText(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const want = new Set(keys);
  const propName = (n: ts.PropertyName) => (ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : null);
  const objDepth = (n: ts.Node) => { let k = 0; for (let p = n.parent; p; p = p.parent) if (ts.isObjectLiteralExpression(p)) k++; return k; };
  const set = (key: string, v: ConfigValue) => {
    const prev = out.get(key);
    if (prev && (prev.kind === "dynamic" || v.kind === "dynamic" || prev.value !== v.value)) out.set(key, { kind: "dynamic" });
    else out.set(key, v);
  };
  const visit = (n: ts.Node) => {
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && ts.isObjectLiteralExpression(n.parent)) {
      const name = propName(n.name);
      const depth = objDepth(n);
      let key: string | null = null;
      if (name && depth === 1 && want.has(name)) key = name;
      else if (name && depth === 2) {
        const owner = n.parent.parent;
        if (ts.isPropertyAssignment(owner) && propName(owner.name) === "build" && want.has(`build.${name}`)) key = `build.${name}`;
      }
      if (key) {
        const init = ts.isPropertyAssignment(n) ? n.initializer : null;
        if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) set(key, { kind: "literal", value: init.text });
        else if (init && init.kind === ts.SyntaxKind.TrueKeyword) set(key, { kind: "literal", value: true });
        else if (init && init.kind === ts.SyntaxKind.FalseKeyword) set(key, { kind: "literal", value: false });
        else set(key, { kind: "dynamic" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const literal = (v: ConfigValue | undefined) => (v?.kind === "literal" ? v.value : undefined);
const str = (v: ConfigValue | undefined) => (typeof literal(v) === "string" ? (literal(v) as string) : undefined);

/** A CLI flag from a build script: `--outDir build`, `--base=/app/`. */
function flag(script: string, name: string): string | undefined {
  return new RegExp(`--${name}(?:=|\\s+)(['"]?)([^\\s'"&;|]+)\\1`).exec(script)?.[2];
}

const cleanDir = (p: string) => path.posix.normalize(p.replace(/\\/g, "/")).replace(/^\.\/+/, "").replace(/\/+$/, "");

export interface ViteSettings {
  file: string | null;
  /** Output directory relative to the repo, or null when it can't be read statically. */
  outDir: string | null;
  base: string | null;
  envPrefix: string | null;
  notes: string[];
}

export function viteSettings(repo: string, pkg: Json): ViteSettings {
  const file = configFile(repo, "vite.config");
  const cfg = file ? readConfig(file, ["root", "base", "envPrefix", "build.outDir"]) : new Map<string, ConfigValue>();
  const script = String(pkg.scripts?.build ?? "");
  const notes: string[] = [];
  const dyn = (k: string) => cfg.get(k)?.kind === "dynamic";

  let outDir: string | null = null;
  const root = str(cfg.get("root"));
  const out = flag(script, "outDir") ?? str(cfg.get("build.outDir"));
  if (dyn("root") || (!flag(script, "outDir") && dyn("build.outDir"))) notes.push("`root` or `build.outDir` in the Vite config isn't a plain string");
  else if (out && path.isAbsolute(out)) notes.push(`\`build.outDir\` is an absolute path (${out})`);
  else outDir = cleanDir(path.posix.join(root ?? ".", out ?? "dist")) || ".";
  if (outDir && (outDir === "." || outDir.startsWith(".."))) { notes.push(`the output directory resolves to '${outDir}'`); outDir = null; }

  const base = flag(script, "base") ?? str(cfg.get("base")) ?? null;
  if (dyn("base") && !flag(script, "base")) notes.push("`base` in the Vite config isn't a plain string");
  const prefix = cfg.get("envPrefix");
  const envPrefix = prefix ? (typeof literal(prefix) === "string" ? (literal(prefix) as string) : "(dynamic)") : null;
  return { file, outDir, base, envPrefix, notes };
}

export interface ReactRouterSettings {
  file: string | null;
  /** false only when the config literally says `ssr: false`. */
  ssr: boolean | "default" | "dynamic";
  outDir: string | null;
  basename: string | null;
  prerender: boolean;
}

export function reactRouterSettings(repo: string): ReactRouterSettings {
  const file = configFile(repo, "react-router.config");
  const cfg = file ? readConfig(file, ["ssr", "basename", "buildDirectory", "prerender"]) : new Map<string, ConfigValue>();
  const ssrV = cfg.get("ssr");
  const ssr = !ssrV ? "default" : ssrV.kind === "dynamic" || typeof ssrV.value !== "boolean" ? "dynamic" : ssrV.value;
  const bd = cfg.get("buildDirectory");
  const outDir = bd?.kind === "dynamic" ? null : cleanDir(path.posix.join(str(bd) ?? "build", "client"));
  return { file, ssr, outDir, basename: str(cfg.get("basename")) ?? null, prerender: cfg.has("prerender") };
}

/** URL path prefix the app is built for, or null when it is served from the root. */
export function basePath(builder: Builder, pkg: Json, vite: ViteSettings | null, rr: ReactRouterSettings | null): { value: string; source: string } | null {
  let raw: string | null = null;
  let source = "";
  if (builder === "cra" && typeof pkg.homepage === "string") { raw = pkg.homepage; source = "`homepage` in package.json"; }
  else if ((builder === "vite" || builder === "react-router") && vite?.base) { raw = vite.base; source = "`base` in the Vite config"; }
  if (builder === "react-router" && rr?.basename) { raw = rr.basename; source = "`basename` in react-router.config"; }
  if (raw === null) return null;
  let p = raw.trim();
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname; } catch { return { value: raw, source }; }
  }
  if (p === "" || p === "." || p === "./" || p === "/") return null;
  return { value: "/" + p.replace(/^\.?\/+|\/+$/g, "") + "/", source };
}

// ---- client environment variables -----------------------------------------------------------

/** Vite's own import.meta.env keys: not application configuration. */
export const VITE_BUILTINS = new Set(["MODE", "BASE_URL", "PROD", "DEV", "SSR"]);
const SECRETISH = /SECRET|PASSW(?:OR)?D|PRIVATE|CREDENTIAL|TOKEN|API_?KEY|ACCESS_?KEY/i;

export interface ClientVar {
  name: string;
  kind: "vite" | "cra";
  where: string; // first "file:line"
  secretish: boolean;
}

export interface ClientEnvScan {
  vars: ClientVar[];
  /** import.meta.env reads without the VITE_ prefix: undefined in the bundle unless envPrefix allows them. */
  unprefixed: string[];
}

const SRC_RE = /\.(?:[cm]?[jt]sx?|html)$/;

/** Source files that end up in the browser bundle (tests, type declarations and tool configs excluded). */
export function clientFiles(repo: string, skipDirs: string[]): string[] {
  const skip = new Set(skipDirs.map((d) => path.join(repo, d)));
  return [...walkFiles(repo, (f) => SRC_RE.test(f) && !f.endsWith(".d.ts") && !/\.(?:spec|test)\.[cm]?[jt]sx?$/.test(f)
    && !/\.config\.[cm]?[jt]s$/.test(f) && ![...skip].some((d) => f.startsWith(d + path.sep)))].slice(0, 5000);
}

export function scanClientEnv(repo: string, files: string[]): ClientEnvScan {
  const vars = new Map<string, ClientVar>();
  const unprefixed = new Set<string>();
  const add = (name: string, kind: "vite" | "cra", f: string, idx: number, text: string) => {
    if (vars.has(name)) return;
    const lineNo = text.slice(0, idx).split("\n").length;
    vars.set(name, { name, kind, where: `${rel(repo, f)}:${lineNo}`, secretish: SECRETISH.test(name) });
  };
  for (const f of files) {
    const text = readText(f);
    if (f.endsWith(".html")) {
      for (const m of text.matchAll(/%((VITE|REACT_APP)_\w+)%/g)) add(m[1], m[2] === "VITE" ? "vite" : "cra", f, m.index ?? 0, text);
      continue;
    }
    const vite = (name: string, idx: number) => {
      if (name.startsWith("VITE_")) add(name, "vite", f, idx, text);
      else if (!VITE_BUILTINS.has(name)) unprefixed.add(name);
    };
    for (const m of text.matchAll(/\bimport\.meta\.env\s*(?:\??\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`]+)\2\s*\])/g)) vite(m[1] ?? m[3], m.index ?? 0);
    for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*import\.meta\.env\b/g))
      for (const part of m[1].split(",")) { const n = part.split(":")[0].split("=")[0].trim(); if (/^[A-Za-z_$][\w$]*$/.test(n)) vite(n, m.index ?? 0); }
    for (const m of text.matchAll(/\bprocess\.env\s*(?:\??\.\s*(REACT_APP_\w+)|\[\s*(['"`])(REACT_APP_\w+)\2\s*\])/g)) add(m[1] ?? m[3], "cra", f, m.index ?? 0, text);
    for (const m of text.matchAll(/\{([^{}]*)\}\s*=\s*process\.env\b/g))
      for (const part of m[1].split(",")) { const n = part.split(":")[0].split("=")[0].trim(); if (n.startsWith("REACT_APP_")) add(n, "cra", f, m.index ?? 0, text); }
  }
  return { vars: [...vars.values()].sort((a, b) => a.name.localeCompare(b.name)), unprefixed: [...unprefixed].sort() };
}

/** .env files in the repo root that the build tools read (Vite and CRA both load these). */
export function envFiles(repo: string): string[] {
  return [...walkFiles(repo, (f) => path.dirname(f) === repo && /^\.env(?:\..+)?$/.test(path.basename(f)))]
    .map((f) => path.basename(f)).filter((n) => !/^\.env\.(?:example|sample|template|dist)$/.test(n)).sort();
}
