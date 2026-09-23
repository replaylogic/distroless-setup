/* Node.js services (plain Node/TypeScript, Express, NestJS, Next.js) on distroless/nodejs. */
import * as path from "path";
import * as ts from "typescript";
import { askImage, parseExistingDockerfile, reviewReferences } from "../../core/docker";
import { exists, isDir, readText, rel, tryJson, validPort, walkFiles } from "../../core/files";
import { InstallAnswers, askInstall, installLines, nodeMajorDefault } from "../../core/npm";
import { ActionItem, Ctx, MARKER, Stack, StackResult, VERSION, mdTable } from "../../core/report";
import { G, fail, info, line, ok, panel, s, section, showDiff, warn } from "../../core/ui";

const SUPPORTED = ["22", "24", "26"]; // distroless nodejs*-debian13
const DEFAULT_MAJOR = "24";
const SRC_EXT = /\.(?:[cm]?[jt]sx?)$/;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Fw = "next" | "nest" | "express" | "fastify" | "koa" | "hono" | "node";

const FW_LABEL: Record<Fw, string> = { next: "Next.js", nest: "NestJS", express: "Express", fastify: "Fastify", koa: "Koa", hono: "Hono", node: "Node.js" };

function deps(pkg: Json): Record<string, string> {
  return { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
}

function framework(pkg: Json): Fw {
  const d = deps(pkg);
  if (d.next) return "next";
  if (d["@nestjs/core"]) return "nest";
  for (const f of ["express", "fastify", "koa", "hono"] as const) if (d[f]) return f;
  return "node";
}

const version = (spec?: string) => (spec ? /(\d+(?:\.\d+)?)/.exec(spec)?.[1] ?? "" : "");

function sourceFiles(repo: string): string[] {
  const roots = ["src", "app", "pages", "server", "lib", "api", "routes"].map((d) => path.join(repo, d)).filter(isDir);
  const top = [...walkFiles(repo, (f) => path.dirname(f) === repo && SRC_EXT.test(f))];
  const files = [...top, ...roots.flatMap((r) => [...walkFiles(r, (f) => SRC_EXT.test(f) && !/\.(spec|test)\.[cm]?[jt]sx?$/.test(f) && !f.endsWith(".d.ts"))])];
  return [...new Set(files)].slice(0, 4000);
}

// ---- entry point ------------------------------------------------------------------------
function tsOutDir(repo: string): { outDir: string | null; rootDir: string | null } {
  for (const f of ["tsconfig.build.json", "tsconfig.json"]) {
    const t = tryJson(path.join(repo, f));
    const co = t?.compilerOptions;
    if (co?.outDir) return { outDir: String(co.outDir).replace(/^\.\//, "").replace(/\/+$/, ""), rootDir: co.rootDir ? String(co.rootDir).replace(/^\.\//, "").replace(/\/+$/, "") : null };
  }
  return { outDir: null, rootDir: null };
}

export function scriptEntry(cmd: string): string | null {
  const m = /(?:^|&&|;|\s)node\s+(?:--?[\w-]+(?:[= ][^\s-][^\s]*)?\s+)*([^\s&|;]+\.?[cm]?js|[^\s&|;-][^\s&|;]*)/.exec(cmd);
  if (!m) return null;
  let f = m[1].replace(/^\.\//, "");
  if (!/\.[cm]?js$/.test(f)) f += ".js";
  return f;
}

export function detectEntry(repo: string, pkg: Json, fw: Fw): { entry: string; why: string; devRunner: string | null } {
  const scripts = pkg.scripts ?? {};
  for (const k of ["start:prod", "start", "serve", "prod"]) {
    const e = scripts[k] ? scriptEntry(scripts[k]) : null;
    if (e) return { entry: e, why: `"${k}" script`, devRunner: null };
  }
  // no script runs plain node: flag a start script that relies on a dev runner
  const devRunner = /\b(ts-node|tsx|nodemon|babel-node)\b/.exec(scripts.start ?? "")?.[1] ?? null;
  const { outDir, rootDir } = tsOutDir(repo);
  if (fw === "nest") {
    const cli = tryJson(path.join(repo, "nest-cli.json")) ?? {};
    const entryFile = cli.entryFile ?? "main";
    return { entry: `${outDir ?? "dist"}/${entryFile}.js`, why: "NestJS defaults (nest-cli.json)", devRunner };
  }
  if (typeof pkg.main === "string" && /\.[cm]?js$/.test(pkg.main)) return { entry: pkg.main.replace(/^\.\//, ""), why: '"main" in package.json', devRunner };
  if (outDir) {
    const src = rootDir ?? (isDir(path.join(repo, "src")) ? "src" : ".");
    for (const n of ["main", "index", "server", "app"])
      if (exists(path.join(repo, src, n + ".ts")) || exists(path.join(repo, src, n + ".mts")))
        return { entry: `${outDir}/${n}.js`, why: `tsconfig outDir + ${src}/${n}.ts`, devRunner };
  }
  for (const c of ["server.js", "index.js", "app.js", "main.js", "src/server.js", "src/index.js", "src/app.js", "src/main.js", "server.mjs", "index.mjs"])
    if (exists(path.join(repo, c))) return { entry: c, why: "found in repo", devRunner };
  return { entry: `${outDir ?? "dist"}/index.js`, why: "guess", devRunner };
}

// ---- Next.js config -------------------------------------------------------------------
function nextConfigFile(repo: string): string | null {
  for (const n of ["next.config.ts", "next.config.mjs", "next.config.js", "next.config.cjs", "next.config.mts"])
    if (exists(path.join(repo, n))) return path.join(repo, n);
  return null;
}

/** Find the config object literal; report `output`, and propose adding output: "standalone". */
export function nextOutput(file: string): { output: string | null; edited: string | null } {
  const text = readText(file);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith("ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const vars = new Map<string, ts.Expression>();
  let target: ts.ObjectLiteralExpression | null = null;
  const unwrap = (e: ts.Expression): ts.Expression => {
    while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
    return e;
  };
  const resolve = (e: ts.Expression | undefined, depth = 0): ts.ObjectLiteralExpression | null => {
    if (!e || depth > 5) return null;
    e = unwrap(e);
    if (ts.isObjectLiteralExpression(e)) return e;
    if (ts.isIdentifier(e)) return resolve(vars.get(e.text), depth + 1);
    if (ts.isCallExpression(e)) { // withBundleAnalyzer(nextConfig), defineConfig({...})
      for (const a of e.arguments) { const r = resolve(a, depth + 1); if (r) return r; }
    }
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) { // (phase) => ({...})
      if (ts.isExpression(e.body as ts.Node)) return resolve(e.body as ts.Expression, depth + 1);
      let found: ts.ObjectLiteralExpression | null = null;
      e.body.forEachChild(function walk(n) { if (!found && ts.isReturnStatement(n) && n.expression) found = resolve(n.expression, depth + 1); if (!found) n.forEachChild(walk); });
      return found;
    }
    return null;
  };
  const exported: ts.Expression[] = [];
  sf.forEachChild(function walk(n) {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) vars.set(n.name.text, n.initializer);
    if (ts.isExportAssignment(n)) exported.push(n.expression);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && n.left.getText(sf) === "module.exports") exported.push(n.right);
    n.forEachChild(walk);
  });
  for (const e of exported) { target = resolve(e); if (target) break; }
  if (!target) return { output: null, edited: null };
  const t = target as ts.ObjectLiteralExpression;
  for (const p of t.properties)
    if (ts.isPropertyAssignment(p) && p.name.getText(sf).replace(/['"]/g, "") === "output") {
      const v = unwrap(p.initializer);
      return { output: ts.isStringLiteralLike(v) ? v.text : p.initializer.getText(sf), edited: null };
    }
  const open = t.getStart(sf) + 1;
  const first = t.properties[0];
  const q = /'[^']*'/.test(text) && !/"[^"]*"/.test(text) ? "'" : '"';
  let edited: string;
  if (!first) {
    const rest = text.slice(open);
    edited = text.slice(0, open) + `\n  output: ${q}standalone${q},` + (/^[ \t]*\r?\n/.test(rest) ? "" : "\n") + rest;
  }
  else {
    const between = text.slice(open, first.getStart(sf));
    const indent = between.includes("\n") ? between.slice(between.lastIndexOf("\n") + 1) : " ";
    edited = text.slice(0, open) + (between.includes("\n") ? `\n${indent}` : " ") + `output: ${q}standalone${q},` + text.slice(open);
  }
  return { output: null, edited };
}

// ---- scans ------------------------------------------------------------------------------
function envVars(files: string[]): { all: string[]; publicNext: string[] } {
  const found = new Set<string>();
  for (const f of files) {
    const t = readText(f);
    for (const m of t.matchAll(/process\.env(?:\.([A-Z_][A-Z0-9_]*)|\[\s*['"`]([A-Z_][A-Z0-9_]*)['"`]\s*\])/g)) found.add(m[1] ?? m[2]);
    for (const m of t.matchAll(/configService\.(?:get|getOrThrow)(?:<[^>]*>)?\(\s*['"`]([A-Z_][A-Z0-9_]*)['"`]/g)) found.add(m[1]);
  }
  const all = [...found].filter((v) => v !== "NODE_ENV").sort();
  return { all, publicNext: all.filter((v) => v.startsWith("NEXT_PUBLIC_")) };
}

function detectPort(files: string[]): { port: string | null; hardcoded: boolean } {
  for (const f of files) {
    const t = readText(f);
    const m = /process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/.exec(t) ?? /Number\(\s*process\.env\.PORT\s*(?:\|\||\?\?)\s*['"]?(\d{2,5})/.exec(t);
    if (m) return { port: m[1], hardcoded: false };
  }
  for (const f of files) {
    const m = /\.listen\(\s*(\d{2,5})\b/.exec(readText(f));
    if (m) return { port: m[1], hardcoded: true };
  }
  return { port: null, hardcoded: false };
}

export function detectHealth(repo: string, files: string[], fw: Fw): string | null {
  const names = "health|healthz|healthcheck|health-check|ready|readyz|readiness|live|livez|liveness|ping|status";
  if (fw === "next") {
    for (const base of ["app", "src/app"]) for (const n of names.split("|"))
      if (["route.ts", "route.js"].some((r) => exists(path.join(repo, base, "api", n, r)))) return `/api/${n}`;
    for (const base of ["pages", "src/pages"]) for (const n of names.split("|"))
      if ([".ts", ".js"].some((e) => exists(path.join(repo, base, "api", n + e)))) return `/api/${n}`;
    return null;
  }
  const re = new RegExp(`['"\`](/(?:api/)?(?:v\\d/)?(?:${names}))['"\`]`);
  const nest = new RegExp(`@Controller\\(\\s*['"\`]/?((?:api/)?(?:${names}))['"\`]`);
  for (const f of files) {
    const t = readText(f);
    const n = nest.exec(t);
    if (n) return "/" + n[1];
    const m = re.exec(t);
    if (m) return m[1];
  }
  return null;
}

const NATIVE: Record<string, string> = {
  puppeteer: "bundles/launches Chromium, which needs system libraries distroless doesn't have. Run browsers in a separate, non-distroless service.",
  playwright: "needs browser binaries and system libraries distroless doesn't have. Run it in a separate, non-distroless service.",
  "playwright-core": "needs browser binaries and system libraries distroless doesn't have.",
  canvas: "links against cairo/pango, which distroless doesn't ship. Consider @napi-rs/canvas (self-contained).",
  "@prisma/client": "works; `prisma generate` must run in the build stage (it does when the schema is copied before install), and migrations belong in a separate Job, not the app container.",
  sharp: "works: prebuilt glibc binaries match Debian-based distroless. Build on the same CPU architecture as you deploy.",
  bcrypt: "native addon: built in the Debian build stage, so it matches the runtime's glibc. Build on the deploy architecture.",
  argon2: "native addon: built in the Debian build stage, so it matches the runtime's glibc.",
  "better-sqlite3": "native addon; also needs a writable path for the database file (readOnlyRootFilesystem needs a volume).",
  sqlite3: "native addon; also needs a writable path for the database file.",
  "node-canvas": "links against system graphics libraries distroless doesn't ship.",
};

function shellUsage(files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    readText(f).split(/\r?\n/).forEach((l, i) => {
      if (/\b(exec|execSync|spawn|spawnSync)\s*\(/.test(l) && /['"`](?:sh|bash|\/bin\/sh|curl|wget|git|ffmpeg|convert|zip|unzip|tar)\b/.test(l))
        hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`);
      else if (/\{\s*shell\s*:\s*true/.test(l)) hits.push(`${f}:${i + 1}: ${l.trim().slice(0, 80)}`);
    });
  }
  return hits;
}

// ---- Dockerfile ------------------------------------------------------------------------
interface Build {
  buildImage: string; install: InstallAnswers; build: string; image: string; port: string; mode: "standalone" | "next-start" | "plain";
  entry: string; copy: string[]; health: string | null; prune: string; hasPublic: boolean; nextConfig: string | null;
}

function healthCmd(p: string, port: string) {
  return `fetch('http://127.0.0.1:'+(process.env.PORT||'${port}')+'${p}').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))`;
}

function renderDockerfile(b: Build): string {
  const L = [
    `# ${MARKER} v${VERSION}. Re-run \`npx distroless-setup node\` to regenerate.`,
    "",
    "# ---- Stage 1: install, build, then drop dev dependencies ----",
    "# Debian-based (trixie) to match the distroless runtime's glibc, so native addons work.",
    `FROM ${b.buildImage} AS build`,
    "WORKDIR /app",
    ...(b.mode !== "plain" ? ["ENV NEXT_TELEMETRY_DISABLED=1"] : []),
    ...installLines(b.install),
    "",
    "COPY . .",
    ...(b.build ? [`RUN ${b.build}`] : []),
    ...(b.mode !== "standalone" ? [`RUN ${b.prune}`] : []),
    "", "",
    "# ---- Stage 2: runtime (distroless: no shell, no package manager) ----",
    `FROM ${b.image}`,
    "WORKDIR /app",
    "# Group 0 ownership keeps files readable under OpenShift's arbitrary UIDs.",
  ];
  if (b.mode === "standalone") {
    L.push("COPY --from=build --chown=65532:0 /app/.next/standalone ./",
      "COPY --from=build --chown=65532:0 /app/.next/static ./.next/static");
    if (b.hasPublic) L.push("COPY --from=build --chown=65532:0 /app/public ./public");
  } else if (b.mode === "next-start") {
    L.push("COPY --from=build --chown=65532:0 /app/node_modules ./node_modules",
      "COPY --from=build --chown=65532:0 /app/package.json ./package.json",
      "COPY --from=build --chown=65532:0 /app/.next ./.next");
    if (b.hasPublic) L.push("COPY --from=build --chown=65532:0 /app/public ./public");
    if (b.nextConfig) L.push(`COPY --from=build --chown=65532:0 /app/${b.nextConfig} ./${b.nextConfig}`);
  } else if (b.copy.includes(".")) {
    L.push("COPY --from=build --chown=65532:0 /app /app");
  } else {
    L.push("COPY --from=build --chown=65532:0 /app/node_modules ./node_modules",
      "COPY --from=build --chown=65532:0 /app/package.json ./package.json",
      ...b.copy.map((c) => `COPY --from=build --chown=65532:0 /app/${c} ./${c}`));
  }
  L.push("",
    `ENV NODE_ENV=production \\`,
    ...(b.mode !== "plain" ? ["    NEXT_TELEMETRY_DISABLED=1 \\", "    HOSTNAME=0.0.0.0 \\"] : []),
    `    PORT=${b.port}`,
    "",
    "USER 65532:0",
    `EXPOSE ${b.port}`, "");
  if (b.health)
    L.push("# No curl/wget in distroless: Node's built-in fetch probes the app.",
      "HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\",
      `  CMD ["/nodejs/bin/node", "-e", ${JSON.stringify(healthCmd(b.health, b.port))}]`, "");
  L.push("# The image's entrypoint is node itself, so CMD is the script (no npm at runtime).",
    `CMD [${b.mode === "next-start" ? '"node_modules/next/dist/bin/next", "start"' : JSON.stringify(b.entry)}]`, "");
  return L.join("\n");
}

// ---- stack ------------------------------------------------------------------------------
export const nodeStack: Stack = {
  id: "node",
  title: "Node.js",
  detect(repo) {
    const pkg = tryJson(path.join(repo, "package.json"));
    if (!pkg || exists(path.join(repo, "angular.json"))) return null;
    const fw = framework(pkg);
    const runnable = fw !== "node" || pkg.scripts?.start || pkg.main;
    return { score: runnable ? 0.9 : 0.3, reason: `package.json${fw !== "node" ? ", " + FW_LABEL[fw] : ""}` };
  },

  async run(ctx: Ctx): Promise<StackResult> {
    const { repo, P, plan } = ctx;
    section("Scanning repo");
    const pkgPath = path.join(repo, "package.json");
    const pkg = tryJson(pkgPath);
    if (!pkg) fail(`package.json not found or unreadable in ${repo}`);
    const fw = framework(pkg);
    const d = deps(pkg);
    const isTs = Boolean(d.typescript) || exists(path.join(repo, "tsconfig.json"));
    const dockerfile = path.join(repo, "Dockerfile");
    const existing = parseExistingDockerfile(dockerfile);
    const files = sourceFiles(repo);
    const fwVersion = version(fw === "next" ? d.next : fw === "nest" ? d["@nestjs/core"] : d[fw]);
    const workspaces = pkg.workspaces || exists(path.join(repo, "pnpm-workspace.yaml")) || exists(path.join(repo, "turbo.json")) || exists(path.join(repo, "nx.json"));

    panel("Before we start", [[null, [
      "The app will run on a distroless Node.js image: no shell, no npm, no package",
      "manager at runtime, non-root, read-only-root friendly. A Debian build stage",
      "installs and builds, then only production files are copied across.",
      "",
      `Detected: ${s(FW_LABEL[fw] + (fwVersion ? " " + fwVersion : ""), "cyan", "bold")}${isTs ? ", TypeScript" : ""}${pkg.name ? `  ${s("(" + pkg.name + ")", "gray")}` : ""}`,
    ]]]);
    if (workspaces) warn("this looks like a monorepo/workspace. v1 targets a single service; run it inside the service's own folder, or check the build command carefully.");
    if (!(await P.confirm(`Continue with ${FW_LABEL[fw]}?`, true))) fail("aborted: no files changed");
    if (exists(dockerfile)) info("existing Dockerfile found (will be backed up and replaced)");

    // ---- Node version
    section("Node.js version");
    let major = nodeMajorDefault(repo, existing, DEFAULT_MAJOR);
    if (!SUPPORTED.includes(major)) {
      const next = SUPPORTED.find((v) => +v >= +major) ?? SUPPORTED[SUPPORTED.length - 1];
      warn(`Node ${major} has no distroless image (published: ${SUPPORTED.join(", ")}); defaulting to ${next}. Test the upgrade.`);
      major = next;
    }
    major = await P.ask(`Node.js major version (${SUPPORTED.join(" / ")})`, major, (v) => (SUPPORTED.includes(v) ? null : `distroless publishes Node ${SUPPORTED.join(", ")}`));

    // ---- build stage
    section("Build stage");
    const buildImage = await P.ask("Build-stage image (Debian trixie, to match the runtime)", `node:${major}-trixie-slim`);
    if (/alpine/i.test(buildImage)) warn("Alpine uses musl; native addons built there crash on the glibc-based distroless runtime. Prefer a -trixie image.");
    const install = await askInstall(repo, P, existing);
    const scripts = pkg.scripts ?? {};
    const buildDef = existing.build ?? (scripts.build ? `${install.pm.run} build` : "");
    const build = await P.ask("Build command (blank = no build step)", buildDef);
    const prune = await P.ask("Command that removes dev dependencies after the build", install.pm.prodPrune);

    // ---- runtime layout
    section("Runtime layout");
    let mode: Build["mode"] = "plain";
    let entry = "";
    let copy: string[] = [];
    let nextConfigRel: string | null = null;
    const notes: string[] = [];
    const actions: ActionItem[] = [];
    if (fw === "next") {
      const cfg = nextConfigFile(repo);
      nextConfigRel = cfg ? rel(repo, cfg) : null;
      const res = cfg ? nextOutput(cfg) : { output: null, edited: null };
      if (res.output === "export") fail("this Next.js app uses `output: 'export'` (a static site). It needs no Node runtime: serve the `out/` folder with any static server. Not handled by this version.");
      if (res.output === "standalone") ok("next.config already sets output: 'standalone'");
      else {
        info("Next.js 'standalone' output traces only the files the server needs: much smaller images and no full node_modules.");
        const opts = ["Enable output: 'standalone' (recommended)", "Keep the current config and run `next start` with production node_modules"];
        const pick = await P.choose("How should Next.js run in the container?", opts, res.output ? 1 : 0);
        if (pick === 0) {
          if (cfg && res.edited) {
            line(`  Proposed change to ${s(rel(repo, cfg), "bold")}:`);
            showDiff(readText(cfg), res.edited, rel(repo, cfg));
            if (await P.confirm(`Apply this change to ${path.basename(cfg)}?`, true)) plan.write(cfg, res.edited, "output: 'standalone'");
            else { mode = "next-start"; }
          } else if (!cfg) {
            const f = path.join(repo, "next.config.mjs");
            plan.write(f, `/** @type {import('next').NextConfig} */\nconst nextConfig = {\n  output: "standalone",\n};\n\nexport default nextConfig;\n`, "output: 'standalone'");
            nextConfigRel = "next.config.mjs";
          } else {
            warn(`couldn't find the config object in ${rel(repo, cfg)}; add \`output: 'standalone'\` yourself`);
            actions.push({ short: `Add output: 'standalone' to ${rel(repo, cfg)}`, md: `Add \`output: 'standalone'\` to the config object in \`${rel(repo, cfg)}\`; the Dockerfile expects \`.next/standalone\`.` });
          }
          if (mode !== "next-start") mode = "standalone";
        } else mode = "next-start";
      }
      if (res.output === "standalone") mode = "standalone";
      if (res.output && res.output !== "standalone" && res.output !== "export") warn(`next.config sets output: ${res.output}`);
      entry = mode === "standalone" ? "server.js" : "next start";
      if (!build) warn("no build command: a Next.js image needs `next build`");
    } else {
      const det = detectEntry(repo, pkg, fw);
      if (det.devRunner) warn(`the start script uses a dev runner (${det.devRunner}); distroless runs compiled JavaScript with plain node`);
      info(`entry point: ${s(det.entry, "bold")} ${s("(" + det.why + ")", "gray")}`);
      entry = await P.ask("Entry file, run as `node <file>`", det.entry, (v) => (/\.[cm]?js$/.test(v) ? null : "must be a .js/.mjs/.cjs file (compile TypeScript in the build step)"));
      if (!build && /^(dist|build|out|lib)\//.test(entry)) warn(`${entry} looks like build output, but there is no build command`);
      const top = entry.split("/")[0];
      const built = entry.includes("/") && ["dist", "build", "out", "lib", tsOutDir(repo).outDir].includes(top);
      const runtimeDirs = ["public", "views", "templates", "static", "locales", "i18n", "assets"].filter((x) => isDir(path.join(repo, x)));
      const def = built ? [top, ...runtimeDirs] : ["."];
      const ans = await P.ask("Paths to copy into the runtime image ('.' = the whole app), comma-separated", def.join(", "));
      copy = ans.split(",").map((x) => x.trim().replace(/^\.\/|\/+$/g, "") || ".").filter(Boolean);
      for (const c of copy) if (c !== "." && c !== top && !exists(path.join(repo, c))) warn(`'${c}' does not exist in the repo (fine if the build creates it)`);
    }

    // ---- port and health
    section("Port and health check");
    const pd = detectPort(files);
    let portDef = pd.port ?? "3000";
    if (validPort(portDef)) { info(`app port ${portDef} is privileged; non-root needs >=1024`); portDef = "3000"; }
    const port = await P.ask("Container port (set as PORT)", portDef, validPort);
    if (pd.hardcoded && pd.port !== port)
      actions.push({ short: `The app listens on a hard-coded port ${pd.port}; read process.env.PORT`, md: `The app calls \`.listen(${pd.port})\` with a hard-coded port, but the container sets \`PORT=${port}\`. Use \`listen(process.env.PORT ?? ${port})\`.` });
    const hDet = detectHealth(repo, files, fw);
    if (hDet) info(`health endpoint found: ${s(hDet, "bold")}`);
    const hAns = await P.ask("Health check path ('none' = no HEALTHCHECK)", hDet ?? (fw === "next" ? "/" : "/health"),
      (v) => (v === "none" || v.startsWith("/") ? null : "start with / or enter 'none'"));
    const health = hAns === "none" ? null : hAns;
    if (health && !hDet && fw !== "next") {
      const snip: Record<string, string> = {
        nest: "a controller: `@Controller('health') export class HealthController { @Get() check() { return { status: 'ok' }; } }` (or @nestjs/terminus)",
        express: "`app.get('" + health + "', (_req, res) => res.json({ status: 'ok' }))`",
        fastify: "`app.get('" + health + "', async () => ({ status: 'ok' }))`",
      };
      actions.push({ short: `Add a ${health} endpoint (the HEALTHCHECK calls it)`, md: `No health endpoint was found. Add one at \`${health}\`, e.g. ${snip[fw] ?? "a route that returns 200"}; the Dockerfile HEALTHCHECK and the Kubernetes probes call it.` });
    }

    section("Runtime image");
    const image = await askImage(P, "Runtime base image", `gcr.io/distroless/nodejs${major}-debian13:nonroot`);

    // ---- checks for the report
    const env = envVars(files);
    const sigterm = fw === "next" || files.some((f) => /SIGTERM|enableShutdownHooks|lightship|terminus|stoppable|http-terminator|close-with-grace/.test(readText(f)));
    if (!sigterm) actions.push({
      short: "Handle SIGTERM so the app shuts down cleanly",
      md: fw === "nest"
        ? "Node runs as PID 1 in the container and gets `SIGTERM` on shutdown. Call `app.enableShutdownHooks()` in `main.ts` so NestJS closes connections instead of being killed after the grace period."
        : "Node runs as PID 1 in the container and gets `SIGTERM` on shutdown. Without a handler the process is killed after the grace period. Add e.g. `process.on('SIGTERM', () => server.close(() => process.exit(0)))`.",
    });
    const native = Object.keys(NATIVE).filter((k) => d[k] && NATIVE[k]);
    const shells = shellUsage(files).map((h) => rel(repo, h.split(":")[0]) + h.slice(h.indexOf(":")));
    if (shells.length) actions.push({ short: `Review ${shells.length} place(s) that run shell commands or external tools`, md: `Review ${shells.length} place(s) that spawn shell commands or external tools (there is no shell or coreutils at runtime); see [Runtime checks](#runtime-checks).` });
    if (native.some((k) => ["puppeteer", "playwright", "playwright-core", "canvas", "node-canvas"].includes(k)))
      actions.push({ short: "Some dependencies need system libraries distroless doesn't have", md: "Some dependencies need system libraries that distroless doesn't ship; see [Runtime checks](#runtime-checks)." });
    if (env.publicNext.length) actions.push({
      short: `${env.publicNext.length} NEXT_PUBLIC_ variable(s) are fixed at build time`,
      md: `${env.publicNext.map((v) => `\`${v}\``).join(", ")} are inlined into the client bundle by \`next build\`, so setting them on the container has no effect. Pass them as build args (\`ARG\`/\`ENV\` before \`RUN ${build || "next build"}\`), or read them on the server at request time.`,
    });
    if (mode === "standalone" || mode === "next-start") notes.push("Next.js writes its cache to `.next/cache` (ISR, image optimisation). With `readOnlyRootFilesystem: true`, mount an `emptyDir` at `/app/.next/cache`.");
    if (d["@prisma/client"] && install.pm.pm === "yarn" && !install.pm.berry) notes.push("Yarn 1 re-installs production dependencies with `--ignore-scripts`; check that the generated Prisma client (`node_modules/.prisma`) survives, or run `prisma generate` after it.");
    if (install.extras.some((e) => e.replace(/\/$/, "") === ".npmrc"))
      actions.push({ short: "Move .npmrc auth tokens to a BuildKit secret", md: "`.npmrc` is copied into the build stage. If it contains registry tokens, use `RUN --mount=type=secret,id=npmrc,target=/app/.npmrc <install>` and `docker build --secret id=npmrc,src=.npmrc` so tokens never land in a layer." });
    if (env.all.length) actions.push({ short: `Set the ${env.all.length} env var(s) the app reads in your deployment`, md: `Set the environment variables the app reads (listed under [Environment variables](#environment-variables)) in your deployment manifests. Keep secrets in a secret store, not in the image.` });

    const b: Build = { buildImage, install, build, image, port, mode, entry, copy, health, prune, hasPublic: isDir(path.join(repo, "public")), nextConfig: nextConfigRel };
    plan.write(dockerfile, renderDockerfile(b), "2-stage distroless build");

    const envNotes = exists(path.join(repo, ".env")) || exists(path.join(repo, ".env.local")) ? ["`.env` / `.env.local` are excluded from the build context by `.dockerignore`, so local secrets never end up in the image."] : [];
    const sections = [
      ["## Runtime", "",
        mdTable(["", ""], [
          ["Framework", FW_LABEL[fw] + (fwVersion ? ` ${fwVersion}` : "") + (isTs ? " (TypeScript)" : "")],
          ["Start", mode === "standalone" ? "`node server.js` (Next.js standalone)" : mode === "next-start" ? "`next start` via `node_modules/next/dist/bin/next`" : `\`node ${entry}\``],
          ["Build image", `\`${buildImage}\``], ["Build", build ? `\`${build}\`` : "none"],
          ["Copied into the image", mode === "plain" ? copy.map((c) => `\`${c}\``).join(", ") + (copy.includes(".") ? "" : ", `node_modules`, `package.json`") : mode === "standalone" ? "`.next/standalone`, `.next/static`" + (b.hasPublic ? ", `public`" : "") : "`node_modules`, `.next`, `package.json`" + (b.hasPublic ? ", `public`" : "")],
          ["Health check", health ? `\`GET ${health}\` via Node's \`fetch\`` : "none"],
        ]), "",
        "There is no `npm` in the runtime image: the image's entrypoint is `node`, so `CMD` names the script directly. Anything your `start` script did beyond `node <file>` (migrations, env loading, `&&` chains) must move into the build stage, the app itself, or a separate Job.", "",
        ...notes.map((n) => `- ${n}`)].join("\n"),
      ["## Environment variables", "",
        env.all.length ? `Found ${env.all.length} variable(s) read through \`process.env\`${fw === "nest" ? " or ConfigService" : ""}:` : "No `process.env` reads were found in the scanned sources.", "",
        ...(env.all.length ? [mdTable(["Variable", "When it's read"], env.all.map((v) => [`\`${v}\``, v.startsWith("NEXT_PUBLIC_") ? "**build time** (inlined into the client bundle)" : "runtime"]))] : []), "",
        "Set runtime variables with `-e`, Compose `environment:`, or Kubernetes `env`/`envFrom`. Changing them only needs a restart, not a rebuild.",
        ...envNotes.map((n) => `\n${n}`)].join("\n"),
      ["## Runtime checks", "",
        ...(native.length ? ["Dependencies worth checking:", "", ...native.map((k) => `- \`${k}\`: ${NATIVE[k]}`), ""] : ["No dependencies with known distroless issues were found.", ""]),
        ...(shells.length ? ["Code that spawns shell commands or external tools (none exist at runtime):", "", ...shells.map((h) => `- \`${h}\``), ""] : []),
        sigterm ? "Graceful shutdown: a SIGTERM handler (or framework support) was found." : "Graceful shutdown: **no SIGTERM handling found** (see Action required)."].join("\n"),
    ];
    const reviewHits = reviewReferences(repo, new Set(), /\bnpm (?:run )?start\b|\bpm2\b/);
    return {
      stack: `Node.js (${FW_LABEL[fw]})`, imageName: (String(pkg.name ?? path.basename(repo)).replace(/^@[^/]+\//, "").replace(/[^a-z0-9._-]/gi, "-").toLowerCase() || "app"),
      port, runtimeImage: image,
      summary: [`Framework: ${FW_LABEL[fw]}${fwVersion ? " " + fwVersion : ""}`, `Start: ${mode === "plain" ? `\`node ${entry}\`` : mode === "standalone" ? "`node server.js` (standalone)" : "`next start`"}`, `Build: ${build ? `\`${build}\`` : "none"}`],
      consoleFacts: [
        `${s(G.ok, "green")} ${mode === "plain" ? `node ${entry}` : mode === "standalone" ? "Next.js standalone (server.js)" : "next start"} on ${image.replace(/@sha256:.*/, "")}`,
        `${s(G.bullet, "gray")} health check: ${health ?? "none"}`,
        `${s(G.bullet, "gray")} ${env.all.length} env var(s) found${env.publicNext.length ? `, ${env.publicNext.length} build-time NEXT_PUBLIC_` : ""}`,
      ],
      actions, sections,
      runEnv: env.all.filter((v) => !v.startsWith("NEXT_PUBLIC_") && v !== "PORT").slice(0, 5).map((v) => `-e ${v}=...`),
      verify: [],
      // Node itself writes nothing; Next.js keeps its ISR/image cache under .next/cache.
      writablePaths: mode === "plain" ? ["/tmp"] : ["/tmp", "/app/.next/cache"],
      dockerignoreRecommended: ["node_modules", "npm-debug.log*", ".git", "coverage", ".next", "dist", ".env", ".env.local", ".env.*.local", "*.pem"],
      dockerignoreNeeded: ["package.json", ...(install.pm.lock ? [install.pm.lock] : []), ...install.extras.map((e) => e.replace(/\/+$/, ""))],
      reviewHits, healthPath: health,
    };
  },
};

