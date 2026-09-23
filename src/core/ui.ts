/* Console output: ANSI colour (NO_COLOR / FORCE_COLOR aware), boxed panels, diffs. */

export class AbortError extends Error {}

type StyleName = "bold" | "dim" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "gray";
const CODES: Record<StyleName, string> = {
  bold: "1", dim: "2", red: "31", green: "32", yellow: "33", blue: "34", magenta: "35", cyan: "36", gray: "90",
};

function detectColor(): boolean {
  const force = process.env.FORCE_COLOR;
  if (force !== undefined && force !== "" && force !== "0") return true;
  if ("NO_COLOR" in process.env) return false;
  if (process.env.TERM === "dumb") return false;
  return Boolean(process.stdout.isTTY);
}

function detectUnicode(): boolean {
  if (process.env.DISTROLESS_SETUP_ASCII) return false;
  if (process.platform !== "win32") {
    const lang = `${process.env.LC_ALL || ""}${process.env.LC_CTYPE || ""}${process.env.LANG || ""}`;
    return lang === "" || /utf-?8/i.test(lang);
  }
  // Windows Terminal, VS Code and modern consoles render UTF-8 fine; legacy conhost may not.
  return Boolean(process.env.WT_SESSION || process.env.TERM_PROGRAM || process.env.ConEmuANSI);
}

export const color = detectColor();
export const uni = detectUnicode();

export const G = uni
  ? { h: "─", v: "│", tl: "╭", tr: "╮", bl: "╰", br: "╯", lt: "├", rt: "┤", ok: "✔", err: "✖", warn: "⚠", bullet: "•", arrow: "→", diamond: "◆", ell: "…" }
  : { h: "-", v: "|", tl: "+", tr: "+", bl: "+", br: "+", lt: "+", rt: "+", ok: "[ok]", err: "[x]", warn: "[!]", bullet: "-", arrow: "->", diamond: "*", ell: "~" };

export function s(text: string | number, ...styles: StyleName[]): string {
  const t = String(text);
  if (!color || styles.length === 0) return t;
  return `\u001b[${styles.map((x) => CODES[x]).join(";")}m${t}\u001b[0m`;
}

const ANSI_RE = /\u001b\[[0-9;]*m/g;
export const strip = (t: string) => t.replace(ANSI_RE, "");
export const vlen = (t: string) => strip(t).length;

export function termWidth(): number {
  const cols = process.stdout.columns || 100;
  return Math.max(60, Math.min(cols, 100));
}

const out = (line = "") => process.stdout.write(line + "\n");

export function banner(title: string, sub: string) {
  const t = ` ${G.diamond} ${title} `;
  const u = ` ${sub} `;
  const w = Math.max(t.length, u.length) + 2;
  out(s(G.tl + G.h.repeat(w) + G.tr, "cyan"));
  out(s(G.v, "cyan") + s(t.padEnd(w), "bold", "cyan") + s(G.v, "cyan"));
  out(s(G.v, "cyan") + s(u.padEnd(w), "dim") + s(G.v, "cyan"));
  out(s(G.bl + G.h.repeat(w) + G.br, "cyan"));
}

export function section(title: string) {
  const w = termWidth();
  out("\n" + s(G.h.repeat(2) + " ", "cyan") + s(title, "bold") + " " + s(G.h.repeat(Math.max(0, w - title.length - 4)), "cyan"));
}

export const info = (msg: string) => out(`  ${s(G.bullet, "gray")} ${msg}`);
export const ok = (msg: string) => out(`  ${s(G.ok, "green")} ${msg}`);
export const warn = (msg: string) => out(`  ${s(G.warn, "yellow")} ${s("WARNING:", "yellow", "bold")} ${msg}`);
export const detail = (msg: string) => out(`      ${s(msg, "gray")}`);
export const line = out;

export function fail(msg: string): never {
  throw new AbortError(msg);
}

function wrap(text: string, width: number, indent: string): string[] {
  const words = text.split(/(\s+)/);
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + w).length > width && cur.trim()) {
      lines.push(cur.trimEnd());
      cur = indent + w.trimStart();
    } else {
      cur += w;
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines.length ? lines : [""];
}

export type Block = [heading: string | null, lines: string[]];

export function panel(title: string, blocks: Block[], c: StyleName = "cyan") {
  const w = termWidth() - 2;
  const inner = w - 3;
  const row = (text = "") => out(s(G.v, c) + "  " + text + " ".repeat(Math.max(0, inner - vlen(text))) + " " + s(G.v, c));
  const head = ` ${title} `;
  out(s(G.tl + G.h.repeat(2), c) + s(head, "bold") + s(G.h.repeat(Math.max(0, w - 2 - vlen(head))) + G.tr, c));
  blocks.forEach(([heading, lines], i) => {
    if (i) out(s(G.lt + G.h.repeat(w) + G.rt, c, "dim"));
    if (heading) row(s(heading, "bold"));
    for (const l of lines) {
      if (vlen(l) <= inner) {
        row(l);
        continue;
      }
      const plain = strip(l);
      const indent = " ".repeat(plain.length - plain.trimStart().length + 3);
      for (const chunk of wrap(plain, inner, indent)) row(chunk);
    }
  });
  out(s(G.bl + G.h.repeat(w) + G.br, c));
}

/** Unified diff (LCS based; fine for config-sized files). Prints it and returns the lines. */
export function showDiff(oldText: string, newText: string, name: string, context = 2): string[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
    dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  type Op = { t: " " | "-" | "+"; text: string; ai: number; bi: number };
  const ops: Op[] = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ t: " ", text: a[i++], ai: i, bi: ++j });
    else if (j < m && (i >= n || dp[i][j + 1] >= dp[i + 1][j])) ops.push({ t: "+", text: b[j++], ai: i, bi: j });
    else ops.push({ t: "-", text: a[i++], ai: i, bi: j });
  }
  const lines: string[] = [`--- a/${name}`, `+++ b/${name}`];
  const changed = ops.map((o, k) => (o.t !== " " ? k : -1)).filter((k) => k >= 0);
  let k = 0;
  while (k < changed.length) {
    const start = Math.max(0, changed[k] - context);
    let end = Math.min(ops.length - 1, changed[k] + context);
    while (k + 1 < changed.length && changed[k + 1] - context <= end + 1) {
      k++;
      end = Math.min(ops.length - 1, changed[k] + context);
    }
    const hunk = ops.slice(start, end + 1);
    const aStart = hunk[0].t === "+" ? hunk[0].ai + 1 : hunk[0].ai;
    const bStart = hunk[0].t === "-" ? hunk[0].bi + 1 : hunk[0].bi;
    const aLen = hunk.filter((o) => o.t !== "+").length;
    const bLen = hunk.filter((o) => o.t !== "-").length;
    lines.push(`@@ -${Math.max(aStart, 1)},${aLen} +${Math.max(bStart, 1)},${bLen} @@`);
    for (const o of hunk) lines.push(o.t + o.text);
    k++;
  }
  for (const l of lines) {
    if (l.startsWith("+++") || l.startsWith("---")) out("    " + s(l, "bold"));
    else if (l.startsWith("+")) out("    " + s(l, "green"));
    else if (l.startsWith("-")) out("    " + s(l, "red"));
    else if (l.startsWith("@@")) out("    " + s(l, "cyan"));
    else out("    " + s(l, "dim"));
  }
  return lines;
}
