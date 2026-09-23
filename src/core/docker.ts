/* Docker-side helpers shared by every stack. */
import * as path from "path";
import { BACKUP_DIR, Plan, exists, isDir, readText, rel, walkFiles } from "./files";
import { Prompter } from "./prompt";
import { info, section, warn } from "./ui";

export interface ExistingDockerfile {
  nodeMajor?: string;
  port?: string;
  npmPin?: string;
  install?: string;
  build?: string;
  extras: string[];
  override?: string;
  cmd?: string;
}

export function parseExistingDockerfile(p: string): ExistingDockerfile {
  const found: ExistingDockerfile = { extras: [] };
  if (!exists(p)) return found;
  let stage = 0;
  let installed = false;
  const text = readText(p).replace(/\\\r?\n/g, " ");
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    if (/^FROM\s/i.test(l)) {
      stage++;
      const m = /^FROM\s+(?:--platform=\S+\s+)?(?:\S+\/)?node:(\d+)/i.exec(l);
      if (m && stage === 1) found.nodeMajor = m[1];
      continue;
    }
    let m = /^EXPOSE\s+(\d+)/i.exec(l);
    if (m) found.port = m[1];
    m = /^(?:CMD|ENTRYPOINT)\s+(.*)$/i.exec(l);
    if (m) found.cmd = m[1];
    if (stage !== 1) continue;
    if ((m = /^RUN\s+npm\s+(?:install|i)\s+-g\s+npm@(\S+)/i.exec(l))) { found.npmPin = m[1]; continue; }
    if (!installed && (m = /^RUN\s+((?:npm\s+(?:ci|install|i)|yarn(?:\s+install)?|pnpm\s+install)\b.*)/i.exec(l))) {
      // keep only the install itself: "npm install && npm run build" must not run before COPY . .
      const parts = m[1].split(/\s*&&\s*/);
      found.install = parts[0].trim();
      const b = parts.slice(1).find((x) => /\b(?:ng\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+(?:run\s+)?build)\b/.test(x));
      if (b) found.build = b.trim();
      installed = true;
      continue;
    }
    if (!installed && /^COPY\s/i.test(l)) {
      const args = l.split(/\s+/).slice(1);
      if (args.length && !l.includes("package") && !args[0].startsWith("--") && args[0] !== ".") found.extras.push(args[0]);
      continue;
    }
    if (installed && (m = /^RUN\s+(.*\b(?:ng\s+build|npm\s+run\s+build|yarn\s+build|pnpm\s+(?:run\s+)?build)\b.*)/i.exec(l))) {
      found.build = m[1];
      continue;
    }
    if (installed && (m = /^COPY\s+(\S+\.json)\s+dist\/\S+/i.exec(l))) found.override = m[1];
  }
  return found;
}

/** Approximates Docker's .dockerignore matching: patterns match a path or any parent; last match wins. */
export function dockerignoreExcludes(p: string, lines: string[]): boolean {
  const parts = p.split("/");
  const candidates = [p, ...parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"))];
  let ignored = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t || t.startsWith("#")) continue;
    const neg = t.startsWith("!");
    const pat = t.replace(/^!/, "").trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (!pat) continue;
    const pats = [pat, pat.startsWith("**/") ? pat.slice(3) : pat];
    if (pats.some((pt) => candidates.some((c) => globToRe(pt).test(c)))) ignored = !neg;
  }
  return ignored;
}

function globToRe(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") { re += ".*"; i++; if (glob[i + 1] === "/") i++; }
    else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re + "$");
}

export async function planDockerignore(repo: string, P: Prompter, plan: Plan, recommended: string[], needed: string[]) {
  section(".dockerignore");
  const p = path.join(repo, ".dockerignore");
  const rec = [...new Set([...recommended, BACKUP_DIR])];
  if (!exists(p)) {
    if (await P.confirm("No .dockerignore found. Create one with recommended entries?", true))
      plan.write(p, rec.join("\n") + "\n", "keeps local artefacts and secrets out of the build context");
    const bad = needed.filter((n) => dockerignoreExcludes(n, rec));
    for (const n of bad) warn(`recommended .dockerignore entries would exclude '${n}'`);
    return;
  }
  const lines = readText(p).split(/\r?\n/);
  const allowlist = lines.some((l) => ["*", "**", "**/*"].includes(l.trim().replace(/^\//, "")));
  let keep: string[] = [];
  const removed: string[] = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t || t.startsWith("#") || t.startsWith("!") || allowlist) { keep.push(l); continue; }
    if (needed.some((n) => dockerignoreExcludes(n, [t]))) removed.push(t);
    else keep.push(l);
  }
  let added: string[] = [];
  if (allowlist) {
    const present = new Set(keep.map((l) => l.trim()));
    for (const n of needed) {
      if (dockerignoreExcludes(n, keep)) {
        const top = n.split("/")[0];
        for (const neg of isDir(path.join(repo, top)) ? [`!${top}/`, `!${top}/**`] : [`!${n}`])
          if (!present.has(neg)) { added.push(neg); present.add(neg); }
      }
    }
  }
  const norm = new Set(keep.map((l) => l.trim().replace(/^\/+/, "").replace(/\/+$/, "")));
  let missing = allowlist ? [] : rec.filter((r) => !norm.has(r.replace(/\/+$/, "")));
  if (removed.length) {
    info("these entries would exclude files the image build needs: " + removed.join(", "));
    if (!(await P.confirm("Remove them?", true))) {
      warn("keeping them. The Docker build will fail until they are removed.");
      keep = lines;
      removed.length = 0;
    }
  }
  if (added.length) {
    info("allowlist-style .dockerignore; these must be re-included: " + added.join(", "));
    if (!(await P.confirm("Add these lines?", true))) added = [];
  }
  if (missing.length) {
    info("recommended entries missing: " + missing.join(", "));
    if (!(await P.confirm("Add them?", true))) missing = [];
  }
  const final = [...keep, ...added, ...missing];
  for (const n of needed) if (dockerignoreExcludes(n, final)) warn(`.dockerignore still excludes '${n}', which the build needs; fix it manually`);
  if (removed.length || added.length || missing.length) {
    let body = keep.join("\n").replace(/\n+$/, "");
    const extra = [...added, ...missing];
    if (extra.length) body += "\n\n# added by distroless-setup\n" + extra.join("\n");
    plan.write(p, body + "\n", "build-context fixes / recommended entries");
  } else {
    info(".dockerignore looks fine");
  }
}

export async function askImage(P: Prompter, question: string, def: string): Promise<string> {
  const image = await P.ask(question, def);
  const digest = await P.ask("Pin it by digest? paste sha256:... (blank = tag only)", "", (v) =>
    !v || /^sha256:[0-9a-f]{64}$/.test(v) ? null : "expected sha256:<64 hex chars>");
  return digest ? `${image}@${digest}` : image;
}

/** CI files / scripts that still mention the old runtime (nginx, shells, curl healthchecks...). */
export function reviewReferences(repo: string, skip: Set<string>, extra: RegExp | null = null): string[] {
  const pat = /nginx|docker-entrypoint|\/usr\/share\/nginx|\bwget\b|\bcurl\b.*localhost|\/bin\/(?:ba)?sh\b/i;
  const exts = new Set([".yml", ".yaml", ".sh", ".mk", ".tf", ".toml"]);
  const names = new Set(["Jenkinsfile", "Makefile", "Procfile", "docker-compose.yml", "compose.yml"]);
  const hits: string[] = [];
  for (const p of walkFiles(repo, (f) => {
    const b = path.basename(f);
    return (exts.has(path.extname(f)) || names.has(b) || b.startsWith("Dockerfile.")) && !skip.has(f)
      && !["pnpm-lock.yaml", "poetry.lock", "uv.lock"].includes(b);
  })) {
    readText(p).split(/\r?\n/).forEach((l, i) => {
      if (pat.test(l) || (extra && extra.test(l))) hits.push(`${rel(repo, p)}:${i + 1}: ${l.trim().slice(0, 90)}`);
    });
  }
  return hits;
}
