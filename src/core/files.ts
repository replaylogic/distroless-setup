/* File helpers and the change plan (every write/remove is backed up before it happens). */
import * as fs from "fs";
import * as path from "path";
import { AbortError, s } from "./ui";

export const BACKUP_DIR = ".distroless-backup";
export const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", ".angular", ".next", ".nuxt", ".nx", "coverage", ".cache",
  ".yarn", ".pnpm-store", ".turbo", ".vercel", ".idea", ".vscode", ".venv", "venv", "env", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".ruff_cache", "site-packages",
  BACKUP_DIR,
]);

export const exists = (p: string) => fs.existsSync(p);
export const isDir = (p: string) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
export const isFile = (p: string) => { try { return fs.statSync(p).isFile(); } catch { return false; } };

export function readText(p: string): string {
  try {
    return fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

export function rel(repo: string, p: string): string {
  return path.relative(repo, p).split(path.sep).join("/");
}

export function* walkFiles(root: string, pred: (p: string) => boolean, skip = SKIP_DIRS): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      if (!skip.has(e.name)) yield* walkFiles(p, pred, skip);
    } else if (e.isFile() && pred(p)) {
      yield p;
    }
  }
}

/** JSON with comments and trailing commas (angular.json, tsconfig.json allow them). */
export function stripJsonc(text: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      out += c;
      if (c === "\\" && i + 1 < text.length) out += text[++i];
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (text.startsWith("//", i)) { const j = text.indexOf("\n", i); i = j < 0 ? text.length : j - 1; continue; }
    if (text.startsWith("/*", i)) { const j = text.indexOf("*/", i + 2); i = j < 0 ? text.length : j + 1; continue; }
    out += c;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function loadJson(p: string): any {
  return JSON.parse(stripJsonc(readText(p)));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tryJson(p: string): any {
  try { return exists(p) ? loadJson(p) : null; } catch { return null; }
}

export const camelToEnv = (key: string) =>
  key.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toUpperCase();

export const validPort = (v: string) =>
  /^\d+$/.test(v) && +v >= 1024 && +v <= 65535 ? null : "use a port between 1024 and 65535 (the container runs as non-root)";

type Action = { kind: "write" | "remove"; path: string; content: string; reason: string };
export type Label = "CREATE" | "UPDATE" | "REMOVE";

const realpath = (p: string) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

/**
 * Where a path really lands, with symlinks resolved: the deepest existing ancestor is
 * resolved, then the missing segments are re-appended. A symlinked file resolves to its
 * target, and a symlinked *parent* directory cannot redirect a write to a new file.
 */
function resolveTarget(p: string): string {
  const abs = path.resolve(p);
  let link: string | null = null;
  try { link = fs.lstatSync(abs).isSymbolicLink() ? fs.readlinkSync(abs) : null; } catch { link = null; }
  if (link !== null) return realpath(path.resolve(path.dirname(abs), link));

  const missing: string[] = [];
  let probe = abs;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) return abs;
    missing.unshift(path.basename(probe));
    probe = parent;
  }
  return path.resolve(realpath(probe), ...missing);
}

/**
 * Refuses any path that would take a write or a removal outside the chosen repo,
 * whether through `..` in an answer or through a symlink pointing elsewhere.
 * Checked when the action is planned, so it fails before anything is written.
 */
function assertInsideRepo(repo: string, p: string) {
  const root = realpath(repo);
  const target = resolveTarget(p);
  const r = path.relative(root, target);
  if (r === "" || r.startsWith("..") || path.isAbsolute(r))
    throw new AbortError(`refusing to touch '${p}': it resolves to ${target}, outside ${root}`);
}

export class Plan {
  actions: Action[] = [];
  readonly stamp: string;
  readonly backupRoot: string;
  private frozen: Map<string, Label> | null = null;

  constructor(public readonly repo: string) {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
    // Two runs in the same second must not share a backup directory: the second would
    // copy over the first run's backups, losing the files as they were before any run.
    let dir = path.join(repo, BACKUP_DIR, stamp);
    for (let n = 2; fs.existsSync(dir); n++) dir = path.join(repo, BACKUP_DIR, `${stamp}-${n}`);
    this.stamp = path.basename(dir);
    this.backupRoot = dir;
  }

  private drop(p: string) {
    this.actions = this.actions.filter((a) => a.path !== p);
  }

  write(p: string, content: string, reason: string) {
    assertInsideRepo(this.repo, p);
    this.drop(p);
    this.actions.push({ kind: "write", path: p, content, reason });
  }

  remove(p: string, reason: string) {
    assertInsideRepo(this.repo, p);
    this.drop(p);
    this.actions.push({ kind: "remove", path: p, content: "", reason });
  }

  pending(p: string): string | null {
    return this.actions.find((a) => a.path === p && a.kind === "write")?.content ?? null;
  }

  /** Current content as it will be after the plan (for chained edits). */
  current(p: string): string {
    return this.pending(p) ?? readText(p);
  }

  label(a: Action): Label {
    return this.frozen?.get(a.path) ?? (a.kind === "remove" ? "REMOVE" : exists(a.path) ? "UPDATE" : "CREATE");
  }

  counts(): Partial<Record<Label, number>> {
    const c: Partial<Record<Label, number>> = {};
    for (const a of this.actions) c[this.label(a)] = (c[this.label(a)] ?? 0) + 1;
    return c;
  }

  willBackup() {
    return this.actions.some((a) => exists(a.path));
  }

  show() {
    const col = { CREATE: "green", UPDATE: "yellow", REMOVE: "red" } as const;
    for (const a of this.actions) {
      const l = this.label(a);
      process.stdout.write(`  ${s(l.padEnd(7), col[l], "bold")} ${rel(this.repo, a.path).padEnd(52)} ${s(a.reason, "gray")}\n`);
    }
  }

  apply(): string | null {
    // Re-check every path before touching anything: an action planned early could have
    // been overtaken by a symlink or a deleted parent, and a half-applied plan is worse
    // than one that never starts.
    for (const a of this.actions) assertInsideRepo(this.repo, a.path);

    this.frozen = new Map(this.actions.map((a) => [a.path, this.label(a)]));
    let backedUp = false;
    const done: string[] = [];
    for (const a of this.actions) {
      try {
        if (exists(a.path)) {
          const dest = path.join(this.backupRoot, rel(this.repo, a.path));
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.cpSync(a.path, dest, { recursive: true });
          backedUp = true;
        }
        if (a.kind === "write") {
          fs.mkdirSync(path.dirname(a.path), { recursive: true });
          fs.writeFileSync(a.path, a.content, "utf8");
        } else if (exists(a.path)) {
          fs.rmSync(a.path, { recursive: true, force: true });
        }
      } catch (e) {
        throw new AbortError(
          `failed to ${a.kind} ${rel(this.repo, a.path)}: ${(e as Error).message}\n` +
          `  ${done.length} file(s) were already changed: ${done.join(", ") || "none"}\n` +
          (backedUp ? `  Their previous contents are in ${rel(this.repo, this.backupRoot)}/` : "  No backup was needed."));
      }
      done.push(rel(this.repo, a.path));
    }
    return backedUp ? this.backupRoot : null;
  }
}
