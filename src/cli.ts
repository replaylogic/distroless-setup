#!/usr/bin/env node
/* distroless-setup: move Angular, React, Node.js and Python apps to distroless images. */
import * as fs from "fs";
import * as path from "path";
import { planDockerignore } from "./core/docker";
import { BACKUP_DIR, Plan, exists, readText, rel } from "./core/files";
import { Prompter } from "./core/prompt";
import { REPORT_NAME, Stack, TOOL, VERSION, printSummary, renderReport } from "./core/report";
import { AbortError, G, banner, info, line, s, section } from "./core/ui";
import { STACKS, detectStacks } from "./stacks";

const HELP = `${s(TOOL, "bold")} v${VERSION}: move an app to a distroless container image.

${s("Usage", "bold")}
  npx ${TOOL} [angular|react|node|python] [path] [options]

  With no stack name, the project type is detected and you confirm it.

${s("Stacks", "bold")}
  angular   Angular 19+ SPA: static Go server on distroless/static, optional
            runtime config.json driven by env vars (no rebuild to change it)
  react     Static/client-rendered React: Vite, React Router in SPA mode
            (ssr: false), Create React App; static Go server on distroless/static
  node      Node.js / TypeScript services: Express, NestJS, Next.js (standalone)
  python    Python services: FastAPI, Flask, Django or a plain script
            (pip, uv, Poetry, Pipenv)

${s("Options", "bold")}
  -y, --yes       accept every default without prompting (CI)
  -n, --dry-run   show the plan; write only ${REPORT_NAME}, marked as a dry run
  -h, --help      show this help
  -v, --version   print the version

Nothing changes until you confirm the plan. Every file it overwrites or removes is
backed up to ${BACKUP_DIR}/<timestamp>/ first. Colours follow NO_COLOR/FORCE_COLOR.
`;

interface Args { stack: Stack | null; repo: string; yes: boolean; dryRun: boolean }

function parseArgs(argv: string[]): Args | null {
  const a: Args = { stack: null, repo: ".", yes: false, dryRun: false };
  const pos: string[] = [];
  for (const x of argv) {
    if (x === "-h" || x === "--help") { process.stdout.write(HELP); return null; }
    if (x === "-v" || x === "--version") { process.stdout.write(VERSION + "\n"); return null; }
    if (x === "-y" || x === "--yes") a.yes = true;
    else if (x === "-n" || x === "--dry-run") a.dryRun = true;
    else if (x.startsWith("-")) throw new AbortError(`unknown option ${x} (see --help)`);
    else pos.push(x);
  }
  const byId = (id: string) => STACKS.find((st) => st.id === id.toLowerCase()) ?? null;
  if (pos.length && byId(pos[0])) a.stack = byId(pos.shift()!);
  else if (pos.length && ["nodejs", "js", "ts", "express", "nestjs", "nest", "next", "nextjs"].includes(pos[0].toLowerCase())) { pos.shift(); a.stack = byId("node"); }
  else if (pos.length && ["py", "fastapi", "django", "flask"].includes(pos[0].toLowerCase())) { pos.shift(); a.stack = byId("python"); }
  if (pos.length > 1) throw new AbortError(`unexpected argument '${pos[1]}' (see --help)`);
  if (pos.length) a.repo = pos[0];
  return a;
}

async function pickStack(repo: string, P: Prompter): Promise<Stack> {
  const found = detectStacks(repo);
  if (!found.length)
    throw new AbortError(`couldn't tell what kind of project ${repo} is (no angular.json, package.json or Python project files). Pass the stack explicitly: npx ${TOOL} <${STACKS.map((st) => st.id).join("|")}> [path]`);
  const opts = found.map(({ st, d }) => `${st.title}  ${s("(" + d.reason + ")", "gray")}`);
  if (found.length === 1) {
    info(`detected: ${s(found[0].st.title, "bold")} ${s("(" + found[0].d.reason + ")", "gray")}`);
    if (!(await P.confirm(`Set up a distroless image for this ${found[0].st.title} project?`, true))) throw new AbortError("aborted: no files changed");
    return found[0].st;
  }
  return found[await P.choose("This repo matches more than one stack. Which one should the image run?", opts, 0)].st;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args) return;
  const repo = path.resolve(args.repo);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) throw new AbortError(`${repo} is not a directory`);
  const P = new Prompter(args.yes);
  try {
    banner(`${TOOL} v${VERSION}`, "distroless images for Angular, React, Node.js and Python");
    line(`  ${s("repo", "gray")} ${repo}` + (args.dryRun ? `   ${s("[dry run]", "yellow")}` : ""));
    const stack = args.stack ?? (section("Project type"), await pickStack(repo, P));
    const plan = new Plan(repo);
    const ctx = { repo, P, plan, dryRun: args.dryRun };
    const r = await stack.run(ctx);

    await planDockerignore(repo, P, plan, r.dockerignoreRecommended, r.dockerignoreNeeded);
    const gitignore = path.join(repo, ".gitignore");
    if (exists(gitignore) && !readText(gitignore).includes(BACKUP_DIR) && (await P.confirm(`Add ${BACKUP_DIR}/ to .gitignore?`, true)))
      plan.write(gitignore, readText(gitignore).replace(/\n*$/, "") + `\n${BACKUP_DIR}/\n`, "ignore backups");

    const hits = r.reviewHits ?? [];
    const reportPath = path.join(repo, REPORT_NAME);
    plan.write(reportPath, "", "what was done + what's left for you");
    section("Plan");
    plan.show();
    if (hits.length) {
      line(`\n  ${s("Review manually", "yellow", "bold")} (may reference nginx/shell tools that no longer exist):`);
      hits.slice(0, 25).forEach((h) => line(`     ${s(h, "gray")}`));
      if (hits.length > 25) line(`     ... and ${hits.length - 25} more`);
    }
    if (args.dryRun) {
      section("Dry run: generated Dockerfile");
      line(plan.pending(path.join(repo, "Dockerfile")) ?? "(unchanged)");
      plan.actions = plan.actions.filter((a) => a.path !== reportPath);
      fs.writeFileSync(reportPath, renderReport(ctx, r, hits), "utf8");
      printSummary(ctx, r, hits, null, rel(repo, reportPath));
      return;
    }
    if (!(await P.confirm("Apply this plan?", true))) throw new AbortError("aborted: no files changed");
    plan.write(reportPath, renderReport(ctx, r, hits), "what was done + what's left for you");
    const backup = plan.apply();
    printSummary(ctx, r, hits, backup, rel(repo, reportPath));
  } finally {
    P.close();
  }
}

main().catch((e: unknown) => {
  if (e instanceof AbortError) {
    process.stderr.write(`  ${s(G.err, "red")} ${s(e.message, "red")}\n`);
    process.exit(1);
  }
  process.stderr.write(`\n${s("unexpected error:", "red", "bold")} ${(e as Error)?.stack ?? e}\n` +
    `Nothing was written unless the plan had already been applied. Please report this at the project's issue tracker.\n`);
  process.exit(2);
});
