/* React: static/client-rendered builds served by the shared Go static server on distroless/static. */
import * as path from "path";
import { askImage, parseExistingDockerfile, reviewReferences } from "../../core/docker";
import { exists, readText, rel, tryJson, walkFiles } from "../../core/files";
import { InstallAnswers, askInstall, installLines, nodeMajorDefault } from "../../core/npm";
import { ActionItem, Ctx, MARKER, Stack, StackResult, VERSION, mdCode, mdTable } from "../../core/report";
import { G, detail, fail, info, line, ok, panel, s, section, warn } from "../../core/ui";
import {
  GO_IMAGE, NO_RUNTIME_CONFIG, NginxScan, RUNTIME_IMAGE, askPort, askServerDir, gatherHeaders, planServer, renderServeStages, scanNginx,
} from "../shared/static-spa";
import {
  BUILDER_LABEL, Builder, ClientVar, ReactRouterSettings, ViteSettings, basePath, classify, clientFiles, configFile, deps, envFiles,
  hasReact, otherFramework, reactRouterSettings, scanClientEnv, serverFramework, viteSettings,
} from "./analysis";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

const DEFAULT_OUT: Record<Builder, string> = { vite: "dist", "react-router": "build/client", cra: "build", generic: "dist" };
const BUILD_DIRS = new Set(["dist", "build", "out"]);
const FRAMEWORK_LABEL = { next: "Next.js", remix: "Remix", gatsby: "Gatsby" } as const;

export function renderDockerfile(o: {
  nodeImage: string; install: InstallAnswers; build: string; out: string; buildArgs: string[];
  goImage: string; image: string; port: string; serverDir: string;
}): string {
  const L = [
    `# ${MARKER} v${VERSION}. Re-run \`npx distroless-setup react\` to regenerate.`,
    "",
    "# ---- Stage 1: build the React app ----",
    `FROM ${o.nodeImage} AS build`,
    "WORKDIR /app",
    ...installLines(o.install),
    "",
    "COPY . .",
  ];
  if (o.buildArgs.length)
    L.push("# Client build-time variables: compiled into the JavaScript bundle and readable by",
      "# anyone who loads the app. Pass public values with --build-arg; never secrets.",
      ...o.buildArgs.map((a) => `ARG ${a}`));
  L.push(`RUN ${o.build}`, "", "", ...renderServeStages(o));
  return L.join("\n");
}

/** Where an existing nginx-based Dockerfile copied the static build from, e.g. `/app/build` -> `build`. */
export function nginxCopySource(dockerfile: string): string | null {
  const text = readText(dockerfile).replace(/\\\r?\n/g, " ");
  const m = /^\s*COPY\s+--from=\S+\s+(\S+)\s+\/usr\/share\/nginx\/html\/?\s*$/im.exec(text);
  if (!m) return null;
  const workdir = /^\s*WORKDIR\s+(\S+)/im.exec(text)?.[1] ?? "/app";
  let src = m[1].replace(/\/+$/, "");
  if (src.startsWith(workdir.replace(/\/+$/, "") + "/")) src = src.slice(workdir.replace(/\/+$/, "").length + 1);
  src = src.replace(/^\.\//, "");
  return src && !src.startsWith("/") && !src.includes("..") ? src : null;
}

function defaultBuild(builder: Builder, pkg: Json, install: InstallAnswers): string {
  if (pkg.scripts?.build) return `${install.pm.run} build`;
  if (builder === "vite") return `${install.pm.exec} vite build`;
  if (builder === "cra") return `${install.pm.exec} react-scripts build`;
  if (builder === "react-router") return `${install.pm.exec} react-router build`;
  return "";
}

/** nginx configs and entrypoint scripts that only exist to run nginx. */
function nginxLeftovers(repo: string, nginx: NginxScan): { files: string[]; substitution: string[] } {
  const scripts = [...walkFiles(repo, (f) => path.basename(f).startsWith("docker-entrypoint") || (f.endsWith(".sh") && readText(f).includes("nginx")))];
  const substitution = scripts.filter((f) => /\benvsubst\b|\bsed\s+-i\b/.test(readText(f))).map((f) => rel(repo, f));
  return { files: [...new Set([...nginx.files, ...scripts])], substitution };
}

export const reactStack: Stack = {
  id: "react",
  title: "React",
  detect(repo) {
    const pkg = tryJson(path.join(repo, "package.json"));
    if (!pkg || exists(path.join(repo, "angular.json"))) return null;
    const d = deps(pkg);
    if (!hasReact(d) || otherFramework(d)) return null;
    const builder = classify(repo, pkg);
    let score: number;
    let reason = BUILDER_LABEL[builder];
    if (builder === "react-router") {
      const rr = reactRouterSettings(repo);
      // Without `ssr: false` it is a server app: offer React only as a low-confidence option.
      [score, reason] = rr.ssr === false ? [0.95, "React Router, ssr: false"] : [0.4, "React Router, SSR not disabled"];
    } else if (builder === "generic") {
      // An unknown builder needs a build script and a browser entry point to count at all.
      const html = ["index.html", "public/index.html", "src/index.html"].some((f) => exists(path.join(repo, f)));
      if (!pkg.scripts?.build || !html) return null;
      score = 0.65;
    } else {
      score = 0.95;
    }
    // A server framework next to React usually means server-side rendering: let Node win.
    const fw = serverFramework(d);
    if (fw) { score = Math.min(score, 0.6); reason += `, but also ${fw}`; }
    return { score, reason: `package.json, ${reason}` };
  },

  async run(ctx: Ctx): Promise<StackResult> {
    const { repo, P, plan } = ctx;
    section("Scanning repo");
    const pkg = tryJson(path.join(repo, "package.json"));
    if (!pkg) fail(`no readable package.json in ${repo}`);
    const d = deps(pkg);
    const other = otherFramework(d);
    if (other === "next")
      fail("this is a Next.js app. Next.js is handled by the node stack: npx distroless-setup node");
    const builder = classify(repo, pkg);
    const vite = builder === "vite" || builder === "react-router" ? viteSettings(repo, pkg) : null;
    const rr = builder === "react-router" ? reactRouterSettings(repo) : null;

    panel("Before we start", [[null, [
      "The React stack containerises a static build: the production build output",
      "(index.html plus assets) served by a tiny Go server on distroless/static.",
      "There is no Node.js at runtime, so server-side rendering does not run.",
      "",
      `Detected: ${s(BUILDER_LABEL[builder], "cyan", "bold")}${pkg.name ? s(`  (${pkg.name})`, "gray") : ""}`,
    ]]], hasReact(d) ? "cyan" : "yellow");
    if (!hasReact(d)) warn("package.json lists neither react nor react-dom");

    let unconfirmedStatic: string | null = null;
    if (other) {
      warn(`this looks like a ${FRAMEWORK_LABEL[other]} project. ${FRAMEWORK_LABEL[other]} deployments can depend on a server or on`);
      line(`    framework-specific hosting; this stack only serves a folder of static files as-is.`);
      if (!(await P.confirm("Does the production build produce a static folder with an index.html to serve as-is?", false)))
        fail(`aborted: ${FRAMEWORK_LABEL[other]} server deployments are not handled by the react stack`);
      unconfirmedStatic = `This is a ${FRAMEWORK_LABEL[other]} project. You confirmed its build output is a static folder; framework-specific hosting features (redirects, functions, server rendering) are not reproduced.`;
    }
    if (rr) {
      const where = rr.file ? rel(repo, rr.file) : "react-router.config.ts (not found)";
      if (rr.ssr === false) ok(`${where}: ssr: false (SPA mode)`);
      else {
        const why = rr.ssr === true ? "sets ssr: true" : rr.ssr === "dynamic" ? "sets ssr to a value that can't be read statically" : "doesn't set ssr, and React Router defaults to ssr: true";
        warn(`${where} ${why}.`);
        line("    React Router framework apps render on a Node server by default. This release's React");
        line("    stack serves static/SPA output only; it does not run React Router SSR.");
        if (!(await P.confirm("Is build/client a complete static SPA build (index.html included) that you want to serve?", false)))
          fail("aborted: set `ssr: false` in react-router.config for SPA mode, or containerise the server build with the node stack");
        unconfirmedStatic = `${where} ${why}. You confirmed the client output is a complete static build; if the app relies on server rendering or loaders, it will not work from this image.`;
      }
      if (rr.prerender) warn("react-router.config sets `prerender`; see the report on how the SPA fallback interacts with it");
    }
    if (!(await P.confirm("Continue setting up a distroless image for this React app?", true))) fail("aborted: no files changed");

    const dockerfile = path.join(repo, "Dockerfile");
    const existing = parseExistingDockerfile(dockerfile);
    const nginx = scanNginx(repo);
    const leftovers = nginxLeftovers(repo, nginx);
    if (exists(dockerfile)) info("existing Dockerfile found (will be backed up and replaced)");
    for (const f of leftovers.files) info(`nginx config / entrypoint: ${rel(repo, f)}`);
    if (nginx.spaFallback) info("nginx `try_files ... /index.html` found: the Go server has the same SPA fallback built in");
    if (nginx.proxies.length) {
      warn("nginx reverse-proxies requests. The static server does NOT proxy:");
      nginx.proxies.forEach((p) => detail(p));
      line("    Move API routing to your ingress/gateway, or call the API by its own URL.");
      if (!(await P.confirm("Continue anyway?", false))) fail("aborted: proxy_pass needs a different solution first");
    }
    for (const o of nginx.other) warn(`${o} - not ported; listed in the report`);
    for (const f of leftovers.substitution) warn(`${f} rewrites files at container start (envsubst/sed); that can't run without a shell`);

    section("Build stage");
    const install = await askInstall(repo, P, existing);
    const major = nodeMajorDefault(repo, existing, "24");
    const nodeImage = await P.ask("Node image for the build stage", `node:${major}-trixie-slim`);
    const buildCmd = await P.ask("Build command", existing.build ?? defaultBuild(builder, pkg, install),
      (v) => (v ? null : "required: the image serves the build output"));

    let outDef = DEFAULT_OUT[builder];
    const notes: string[] = [];
    if (vite && builder === "vite") {
      if (vite.outDir) outDef = vite.outDir;
      else notes.push(...vite.notes);
    }
    if (rr?.outDir) outDef = rr.outDir;
    const fromNginx = exists(dockerfile) ? nginxCopySource(dockerfile) : null;
    if (other) {
      outDef = fromNginx ?? (other === "gatsby" ? "public" : "build/client");
      notes.push(`the output directory of a ${FRAMEWORK_LABEL[other]} build isn't read from its configuration`);
    } else if (builder === "generic") {
      if (fromNginx) { outDef = fromNginx; info(`the existing Dockerfile copies ${fromNginx}/ into nginx`); }
      else notes.push("the build tool isn't one this stack recognises, so the output directory is a guess");
    }
    for (const n of notes) warn(`${n}: enter the directory that contains the built index.html`);
    const outDir = (await P.ask("Build output directory (contains index.html)", outDef,
      (v) => (v && !path.isAbsolute(v) && !v.split(/[\\/]/).includes("..") && v.replace(/^\.?\/+|\/+$/g, "") ? null : "a relative folder inside the repo"))).replace(/\\/g, "/").replace(/^\.?\/+|\/+$/g, "");
    const outGuessed = notes.length > 0 && outDir === outDef;

    const env = scanClientEnv(repo, clientFiles(repo, []));
    const dotenv = envFiles(repo);
    if (env.vars.length) info(`client build-time variables: ${env.vars.map((v) => v.name).join(", ")}`);
    for (const v of env.vars.filter((x) => x.secretish)) warn(`${v.name} looks like a credential, and it will be readable in the browser bundle`);
    const base = basePath(builder, pkg, vite, rr);
    if (base) warn(`the app is built for the path prefix ${base.value} (${base.source}); see the report`);

    const headers = await gatherHeaders(repo, P, nginx);

    section("Runtime image");
    const port = await askPort(P, [existing.port, nginx.listen]);
    const image = await askImage(P, "Runtime base image", RUNTIME_IMAGE);
    const goImage = await P.ask("Go builder image (Go 1.24+)", GO_IMAGE);
    const serverDir = await askServerDir(repo, P);

    const buildArgs = env.vars.map((v) => v.name);
    plan.write(dockerfile, renderDockerfile({ nodeImage, install, build: buildCmd, out: outDir, buildArgs, goImage, image, port, serverDir }),
      "3-stage distroless build (Node build, Go server, distroless/static)");
    const serverFiles = planServer(plan, repo, serverDir, NO_RUNTIME_CONFIG, headers);

    section("Cleanup of files the new approach replaces");
    const nontrivial = nginx.other.length + nginx.dynamic.length + leftovers.substitution.length > 0;
    let removed = false;
    if (leftovers.files.length) {
      leftovers.files.forEach((f) => info(rel(repo, f)));
      if (nontrivial) warn("they contain behaviour the static server doesn't reproduce (listed in the report)");
      if (await P.confirm("Remove these (backed up first)?", !nontrivial)) {
        leftovers.files.forEach((f) => plan.remove(f, "replaced by the static server"));
        removed = true;
      }
    } else info("nothing to clean up");

    const needed = ["package.json", ...(install.pm.lock ? [install.pm.lock] : []), ...install.extras.map((e) => e.replace(/\/+$/, "")), ...serverFiles,
      ...[configFile(repo, "vite.config"), configFile(repo, "react-router.config")].filter((f): f is string => Boolean(f)).map((f) => rel(repo, f)),
      ...["index.html", "public/index.html"].filter((f) => exists(path.join(repo, f)))];
    const outTop = outDir.split("/")[0];
    const r = report({ repo, builder, pkg, buildCmd, outDir, outGuessed, env: env.vars, unprefixed: builder === "vite" || builder === "react-router" ? env.unprefixed : [],
      dotenv, vite, rr, base, nginx, leftovers, removed, unconfirmedStatic });
    return {
      stack: BUILDER_LABEL[builder],
      imageName: String(pkg.name ?? path.basename(repo)).replace(/^@[^/]+\//, "").replace(/[^a-z0-9._-]/gi, "-").toLowerCase() || "app",
      port, runtimeImage: image,
      summary: [`Build: \`${buildCmd}\``, `Build output: \`${outDir}\``, `Client build-time variables: ${env.vars.length}`,
        `Base path: ${base ? `\`${base.value}\`` : "/"}`],
      consoleFacts: [
        `${s(G.ok, "green")} ${outDir}/ served by the Go static server (SPA fallback, /healthz)`,
        `${env.vars.length ? s(G.warn, "yellow") : s(G.bullet, "gray")} ${env.vars.length} client build-time variable(s)${env.vars.length ? ": set with --build-arg, not at runtime" : ""}`,
        ...(base ? [`${s(G.warn, "yellow")} built for ${base.value}: the ingress must strip it`] : []),
      ],
      actions: r.actions, sections: r.sections,
      runEnv: [],
      verify: [`curl -sI http://localhost:${port}/some/deep/route    # 200, SPA fallback to index.html`,
        `curl -sI -H 'Accept-Encoding: gzip' http://localhost:${port}/   # Content-Encoding: gzip`],
      // The build stage does `COPY . .`: keep local secrets (and .env files the bundler would inline) out of the context.
      dockerignoreRecommended: ["node_modules", ...(BUILD_DIRS.has(outTop) ? [outTop] : []), ...(builder === "react-router" ? [".react-router"] : []),
        ".git", "coverage", ".env", ".env.*", "!.env.example", "*.pem", "*.key"],
      dockerignoreNeeded: needed,
      reviewHits: reviewReferences(repo, new Set(removed ? leftovers.files : []), /\bvite preview\b|\bserve\s+-s\b|\bhttp-server\b/),
      healthPath: "/healthz",
      writablePaths: [],
    };
  },
};

interface ReportInput {
  repo: string; builder: Builder; pkg: Json; buildCmd: string; outDir: string; outGuessed: boolean;
  env: ClientVar[]; unprefixed: string[]; dotenv: string[]; vite: ViteSettings | null; rr: ReactRouterSettings | null;
  base: { value: string; source: string } | null; nginx: NginxScan; leftovers: { files: string[]; substitution: string[] };
  removed: boolean; unconfirmedStatic: string | null;
}

function report(o: ReportInput): { actions: ActionItem[]; sections: string[] } {
  const actions: ActionItem[] = [];
  const code = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");
  const secretish = o.env.filter((v) => v.secretish);
  if (secretish.length)
    actions.push({ short: `Move ${secretish.length} credential-like variable(s) out of the browser bundle`,
      md: `Move ${code(secretish.map((v) => v.name))} out of the client build. Every \`VITE_*\` / \`REACT_APP_*\` value is compiled into JavaScript that anyone can download; a secret there is public. Keep secrets on a server and have the app call it. See [Client build-time variables](#client-build-time-variables).` });
  if (o.unconfirmedStatic)
    actions.push({ short: "Check the static build is the whole app (server rendering was not confirmed off)", md: o.unconfirmedStatic });
  if (o.outGuessed)
    actions.push({ short: `Check that ${o.outDir}/ is the folder with the built index.html`,
      md: `The build output directory \`${o.outDir}\` was not read from your build configuration. Check that \`${o.buildCmd}\` writes \`index.html\` there; the server refuses to start without it.` });
  if (o.env.length)
    actions.push({ short: `Pass ${o.env.length} client variable(s) with docker build --build-arg (not at runtime)`,
      md: `Pass ${code(o.env.map((v) => v.name))} as \`docker build --build-arg NAME=value\`. The bundler compiles them into the JavaScript during the build; setting them on the running container changes nothing. See [Client build-time variables](#client-build-time-variables).` });
  // `.local` files are machine-local overrides by convention; the others are usually committed build config.
  const shared = o.dotenv.filter((f) => !f.endsWith(".local"));
  if (shared.length)
    actions.push({ short: `${code(shared).replace(/`/g, "")} kept out of the Docker build: pass public values with --build-arg`,
      md: `${code(shared)} ${shared.length > 1 ? "are" : "is"} excluded from the build context by the recommended \`.dockerignore\` entries, so values the bundler would read from ${shared.length > 1 ? "them" : "it"} are not in the image. Pass public values with \`--build-arg\`. Only if a file is committed on purpose and holds nothing secret, re-include it with a \`!${shared[0]}\` line in \`.dockerignore\`.` });
  if (o.base)
    actions.push({ short: `Route ${o.base.value} to the container with the prefix stripped`,
      md: `The app is built for \`${o.base.value}\` (${o.base.source}), but the container serves it from \`/\`. Configure the ingress or gateway to strip \`${o.base.value}\` before forwarding. See [Base path](#base-path).` });
  const notPorted = [...o.nginx.other, ...o.nginx.dynamic.map(([n, v]) => `header '${n}: ${v}' uses nginx variables`)];
  if (notPorted.length || o.leftovers.substitution.length)
    actions.push({ short: "Review nginx behaviour the static server doesn't reproduce",
      md: "Review the nginx behaviour the static server doesn't reproduce, listed under [Replaced nginx setup](#replaced-nginx-setup). Move it to your ingress or drop it deliberately." });

  const sections: string[] = [];
  const note: Record<Builder, string> = {
    vite: "Vite writes the production build to the output directory above. `vite preview` is a local preview server and is not used in the image.",
    "react-router": "React Router SPA mode (`ssr: false`) writes a static client build to `build/client` (or `<buildDirectory>/client`). Server rendering, server loaders and actions do not run in this image."
      + (o.rr?.prerender ? " The config also sets `prerender`: prerendered routes are served from their own HTML files, and every other path falls back to `index.html`." : ""),
    cra: "Create React App is deprecated upstream. It is supported here so existing apps can move to a distroless image; for new projects, use Vite or a React framework instead.",
    generic: "The build tool isn't one this stack recognises. The build command and output directory come from your answers, not from build configuration; nothing builder-specific is assumed.",
  };
  sections.push(["## React build", "",
    mdTable(["", ""], [["App type", BUILDER_LABEL[o.builder]], ["Build", mdCode(o.buildCmd)], ["Output served", `\`${o.outDir}\``],
      ["Runtime", "Go static file server on distroless/static"], ["Routing", "unknown paths fall back to `index.html`; missing assets are a real 404"]]), "",
    note[o.builder], "",
    "The runtime image holds the compiled server and the build output only: no Node.js, no `node_modules`, no shell. Assets with a content hash in their name (`index-BWoJ4fK0.js`, `main.8e3f1a2b.js`) are cached for a year as immutable; other files, such as `favicon.ico` or anything copied from `public/`, are revalidated on every use.",
  ].join("\n"));

  const L = ["## Client build-time variables", ""];
  if (o.env.length) {
    L.push("These are read by browser code and replaced by the bundler **during the build**:", "",
      mdTable(["Variable", "Convention", "First seen", "Warning"], o.env.map((v) => [`\`${v.name}\``, v.kind === "vite" ? "Vite `VITE_*`" : "CRA `REACT_APP_*`", `\`${v.where}\``, v.secretish ? "looks like a credential" : ""])), "");
  } else L.push("No `import.meta.env.VITE_*` or `process.env.REACT_APP_*` reads were found in the app source.", "");
  L.push("> [!IMPORTANT]",
    "> Setting `VITE_*` on the running container does not change an already-built browser bundle. The same holds for `REACT_APP_*`: both are compiled into the JavaScript at build time. They are not runtime environment variables.", "",
    "- Set them when the image is built. The Dockerfile declares an `ARG` for each variable found, so `docker build --build-arg VITE_API_URL=https://api.example.com .` works. A different value needs a different image.",
    "- Every value is **public**: anyone who loads the app can read it in the JavaScript. Never put API secrets, passwords or private keys in `VITE_*` or `REACT_APP_*`.",
    "- Vite's own values (`MODE`, `BASE_URL`, `PROD`, `DEV`, `SSR`) are not counted as application variables.",
    "- This release does not add runtime configuration to React apps. To change settings per environment without rebuilding, the app itself has to load them at runtime (for example, fetch a JSON file on startup).", "");
  if (o.unprefixed.length)
    L.push(`\`import.meta.env\` also reads ${code(o.unprefixed)}. Vite only exposes variables with its env prefix (\`${o.vite?.envPrefix ?? "VITE_"}\`), so these are \`undefined\` in the built app unless \`envPrefix\` includes them.`, "");
  if (o.vite?.envPrefix) L.push(`The Vite config sets \`envPrefix\` to \`${o.vite.envPrefix}\`; only \`VITE_*\` reads were scanned.`, "");
  if (o.dotenv.length)
    L.push(`Local env files: ${code(o.dotenv)}. Vite and Create React App read them during the build, but the recommended \`.dockerignore\` keeps them out of the build context (\`.env.example\` stays in), so a secret in them can't be baked into the image by accident.`, "");
  sections.push(L.join("\n"));

  if (o.base) {
    sections.push(["## Base path", "",
      `The app is built for \`${o.base.value}\` (${o.base.source}): \`index.html\` refers to its assets as \`${o.base.value}assets/...\` or similar. The container serves the build output from \`/\` and does not know about the prefix, so:`, "",
      `- **Ingress strips the prefix** (\`${o.base.value}x\` is forwarded as \`/x\`): works.`,
      `- **Ingress keeps the prefix**: asset requests 404 and client routes fall back to \`index.html\`. Not supported by this release's server.`, "",
      "Nothing in your config was changed.",
    ].join("\n"));
  }

  if (o.leftovers.files.length || o.nginx.spaFallback) {
    const N = ["## Replaced nginx setup", ""];
    if (o.leftovers.files.length) N.push(`${o.removed ? "Removed (backed up first)" : "Found, and left in place"}: ${code(o.leftovers.files.map((f) => rel(o.repo, f)))}.`, "");
    N.push("Reproduced by the Go server: serving static files, the SPA fallback (`try_files ... /index.html`), gzip, and `add_header` security headers (merged into the generated server config).", "");
    if (o.nginx.proxies.length) N.push("**Not reproduced: reverse proxying.** Route these at your ingress instead:", "", ...o.nginx.proxies.map((p) => `- \`${p}\``), "");
    if (notPorted.length) N.push("**Not reproduced:**", "", ...notPorted.map((p) => `- ${p}`), "");
    if (o.leftovers.substitution.length)
      N.push(`**Not reproduced: start-up file rewriting.** ${code(o.leftovers.substitution)} rewrite files when the container starts (envsubst/sed), typically to inject runtime config. A distroless image has no shell to run them; the values have to be set at build time or loaded by the app at runtime.`, "");
    sections.push(N.join("\n"));
  }
  return { actions, sections };
}
