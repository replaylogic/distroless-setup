/* Interactive prompts. Works with a TTY and with piped stdin (one answer per line; EOF = defaults). */
import * as readline from "readline";
import { G, fail, s } from "./ui";

class LineReader {
  private queue: string[] = [];
  private waiters: ((v: string | null) => void)[] = [];
  private closed = false;
  private rl: readline.Interface;

  constructor() {
    this.rl = readline.createInterface({ input: process.stdin, terminal: false });
    this.rl.on("line", (l) => {
      const w = this.waiters.shift();
      if (w) w(l);
      else this.queue.push(l);
    });
    this.rl.on("close", () => {
      this.closed = true;
      for (const w of this.waiters.splice(0)) w(null);
    });
  }

  next(): Promise<string | null> {
    if (this.queue.length) return Promise.resolve(this.queue.shift()!);
    if (this.closed) return Promise.resolve(null);
    return new Promise((res) => this.waiters.push(res));
  }

  close() {
    this.rl.close();
  }
}

export class Prompter {
  private reader: LineReader | null = null;
  constructor(public readonly yes: boolean) {}

  private async input(text: string): Promise<string> {
    process.stdout.write(text);
    this.reader ??= new LineReader();
    const l = await this.reader.next();
    if (l === null) {
      process.stdout.write("\n");
      return "";
    }
    if (!process.stdin.isTTY) process.stdout.write(l + "\n"); // echo piped answers
    return l.trim();
  }

  close() {
    this.reader?.close();
  }

  private q(question: string) {
    return `  ${s("?", "magenta", "bold")} ${s(question, "bold")}`;
  }

  async ask(question: string, def = "", validate?: (v: string) => string | null | undefined): Promise<string> {
    for (;;) {
      const suffix = def ? ` ${s("[" + def + "]", "gray")}` : "";
      const ans = this.yes ? def : (await this.input(`${this.q(question)}${suffix}: `)) || def;
      const err = validate?.(ans);
      if (!err) return ans;
      if (this.yes) fail(`default for '${question}' is invalid: ${err}`);
      process.stdout.write(`    ${s(G.err + " " + err, "red")}\n`);
    }
  }

  async confirm(question: string, def = true): Promise<boolean> {
    if (this.yes) return def;
    const hint = def ? "Y/n" : "y/N";
    for (;;) {
      const ans = (await this.input(`${this.q(question)} ${s("[" + hint + "]", "gray")}: `)).toLowerCase();
      if (!ans) return def;
      if (ans === "y" || ans === "yes") return true;
      if (ans === "n" || ans === "no") return false;
    }
  }

  async choose(question: string, options: string[], def = 0): Promise<number> {
    if (this.yes || options.length === 1) return def;
    process.stdout.write(this.q(question) + "\n");
    options.forEach((o, i) => {
      const mark = i === def ? s(G.arrow, "cyan") : " ";
      process.stdout.write(`    ${mark} ${s(i + 1 + ")", "cyan")} ${o}\n`);
    });
    for (;;) {
      const ans = await this.input(`    choice ${s("[" + (def + 1) + "]", "gray")}: `);
      if (!ans) return def;
      const n = Number(ans);
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return n - 1;
      process.stdout.write(`    ${s("enter a number from the list", "red")}\n`);
    }
  }

  async multi(question: string, options: string[], defaults: number[]): Promise<number[]> {
    if (this.yes || !options.length) return [...defaults];
    process.stdout.write(this.q(question) + "\n");
    options.forEach((o, i) => {
      const mark = defaults.includes(i) ? s(G.ok, "green") : " ";
      process.stdout.write(`    ${mark} ${s(i + 1 + ")", "cyan")} ${o}\n`);
    });
    const shown = defaults.map((d) => d + 1).join(",") || "none";
    for (;;) {
      const ans = (await this.input(`    numbers, comma-separated, 'none' or 'all' ${s("[" + shown + "]", "gray")}: `)).toLowerCase();
      if (!ans) return [...defaults];
      if (ans === "none") return [];
      if (ans === "all") return options.map((_, i) => i);
      const picks = ans.split(",").map((p) => p.trim()).filter(Boolean).map(Number);
      if (picks.every((p) => Number.isInteger(p) && p >= 1 && p <= options.length))
        return [...new Set(picks.map((p) => p - 1))].sort((a, b) => a - b);
      process.stdout.write(`    ${s("use numbers from the list", "red")}\n`);
    }
  }

  async lines(question: string): Promise<string[]> {
    if (this.yes) return [];
    process.stdout.write(`${this.q(question)} ${s("(blank line to finish)", "gray")}\n`);
    const out: string[] = [];
    for (;;) {
      const l = await this.input(`    ${s(">", "cyan")} `);
      if (!l) return out;
      out.push(l);
    }
  }
}
