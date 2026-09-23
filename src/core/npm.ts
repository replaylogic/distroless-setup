/* Package-manager detection shared by the Angular and Node stacks. */
import * as path from "path";
import { ExistingDockerfile } from "./docker";
import { exists, isDir, readText, tryJson } from "./files";
import { Prompter } from "./prompt";
import { info, warn } from "./ui";

export interface PkgManager {
  pm: "npm" | "yarn" | "pnpm";
  lock: string | null;
  install: string;
  prodPrune: string;
  run: string; // "npm run" | "yarn" | "pnpm"
  exec: string; // "npx" | "yarn" | "pnpm exec"
  berry: boolean;
}

export function detectPm(repo: string): PkgManager {
  if (exists(path.join(repo, "pnpm-lock.yaml")))
    return { pm: "pnpm", lock: "pnpm-lock.yaml", install: "pnpm install --frozen-lockfile", prodPrune: "pnpm prune --prod", run: "pnpm run", exec: "pnpm exec", berry: false };
  if (exists(path.join(repo, "yarn.lock"))) {
    const berry = exists(path.join(repo, ".yarnrc.yml"));
    return berry
      ? { pm: "yarn", lock: "yarn.lock", install: "yarn install --immutable", prodPrune: "yarn workspaces focus --all --production", run: "yarn run", exec: "yarn", berry }
      : { pm: "yarn", lock: "yarn.lock", install: "yarn install --frozen-lockfile", prodPrune: "yarn install --frozen-lockfile --production --ignore-scripts --prefer-offline", run: "yarn run", exec: "yarn", berry };
  }
  const lock = exists(path.join(repo, "package-lock.json")) ? "package-lock.json" : exists(path.join(repo, "npm-shrinkwrap.json")) ? "npm-shrinkwrap.json" : null;
  return { pm: "npm", lock, install: lock ? "npm ci" : "npm install", prodPrune: "npm prune --omit=dev", run: "npm run", exec: "npx", berry: false };
}

export function nodeMajorDefault(repo: string, existing: ExistingDockerfile, fallback: string): string {
  if (existing.nodeMajor) return existing.nodeMajor;
  for (const f of [".nvmrc", ".node-version"]) {
    const m = /(\d+)/.exec(readText(path.join(repo, f)));
    if (m) return m[1];
  }
  const eng = tryJson(path.join(repo, "package.json"))?.engines?.node;
  const m = /(\d+)/.exec(String(eng ?? ""));
  return m ? m[1] : fallback;
}

export interface InstallAnswers {
  pm: PkgManager;
  npmPin: string;
  install: string;
  extras: string[];
}

/** Questions for the dependency-install part of a Node-based build stage. */
export async function askInstall(repo: string, P: Prompter, existing: ExistingDockerfile): Promise<InstallAnswers> {
  const pm = detectPm(repo);
  const pkg = tryJson(path.join(repo, "package.json")) ?? {};
  info(`package manager: ${pm.pm}${pm.berry ? " (berry)" : ""}` + (pm.lock ? ` (lockfile ${pm.lock})` : " (no lockfile!)"));
  if (!pm.lock) warn("no lockfile found; builds won't be reproducible");
  if (exists(path.join(repo, "bun.lockb")) || exists(path.join(repo, "bun.lock")))
    warn("bun lockfile found; the build uses Node tooling, so make sure a Node lockfile is committed too");

  let npmPin = existing.npmPin ?? "";
  const pmField: string = pkg.packageManager ?? "";
  if (pm.pm === "npm" && pmField.startsWith("npm@")) npmPin = pmField.split("@")[1].split("+")[0];
  if (pm.pm === "npm") npmPin = await P.ask("Pin a specific npm version? (blank = the image's npm)", npmPin);
  // A plain "npm install" from an old Dockerfile ignores the lockfile; prefer the reproducible command.
  const prev = existing.install && !(pm.lock && /^npm\s+(install|i)\s*$/.test(existing.install)) ? existing.install : null;
  const install = await P.ask("Dependency install command", prev ?? pm.install);

  const extras = [...existing.extras];
  for (const grp of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const spec of Object.values<unknown>(pkg[grp] ?? {})) {
      if (typeof spec === "string" && (spec.startsWith("file:") || spec.startsWith("link:"))) {
        const top = spec.replace(/^(file|link):/, "").replace(/^\.\//, "").split("/")[0];
        if (top && top !== ".." && exists(path.join(repo, top))) extras.push(top);
      }
    }
  }
  for (const f of [".npmrc", ".yarnrc", ".yarnrc.yml", ".yarn", ".pnpmfile.cjs", "pnpm-workspace.yaml", "patches", "prisma"])
    if (exists(path.join(repo, f))) extras.push(f);
  const norm = [...new Set(extras.map((e) => e.replace(/\/+$/, "") + (isDir(path.join(repo, e.replace(/\/+$/, ""))) ? "/" : "")))];
  const ans = await P.ask("Files/dirs needed BEFORE install, comma-separated (file: deps, .npmrc, patches, prisma...)", norm.join(", "));
  const list = ans.split(",").map((e) => e.trim()).filter(Boolean);
  for (const e of list) if (!exists(path.join(repo, e.replace(/\/+$/, "")))) warn(`'${e}' does not exist in the repo; the Docker build will fail on that COPY`);
  if (list.some((e) => e.replace(/\/$/, "") === ".npmrc"))
    warn(".npmrc is copied into the build stage. If it holds auth tokens, use a BuildKit secret mount instead (see the report).");
  return { pm, npmPin, install, extras: list };
}

/** Dockerfile lines for the install part of a Node build stage. */
export function installLines(a: InstallAnswers): string[] {
  const L: string[] = [];
  if (a.pm.pm !== "npm") L.push("RUN corepack enable");
  if (a.npmPin) L.push(`RUN npm install -g npm@${a.npmPin}`);
  const manifests = ["package.json", a.pm.lock].filter(Boolean).join(" ");
  L.push("", "# Dependency manifests first for layer caching", `COPY ${manifests} ./`);
  for (const e of a.extras) L.push(`COPY ${e} ${e}`);
  L.push(`RUN ${a.install}`);
  return L;
}
