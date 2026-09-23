#!/usr/bin/env node
/*
 * Renders the terminal screenshots under docs/assets/guides/<stack>/ from the CLI's
 * real, current output — never hand-written text. It runs the built CLI
 * (`dist/cli.js`) against a fresh copy of the matching integration fixture, exactly
 * like the container integration tests do, then renders the captured text into a
 * terminal-styled HTML page and screenshots it with a local Chromium-based browser
 * (Chrome or Edge) in headless mode.
 *
 * This exists alongside the VHS `.tape` scripts in this folder, not instead of them.
 * VHS (https://github.com/charmbracelet/vhs) needs `ttyd` and `ffmpeg`, which don't
 * have first-class Windows builds; this script has no dependency beyond Node.js and a
 * Chromium browser already on the machine, so it's what actually produced the PNGs
 * committed under docs/assets/guides/. On macOS/Linux with VHS installed, prefer the
 * `.tape` scripts for animated recordings — this script is the portable fallback for
 * static screenshots.
 *
 * Usage (from the repo root, after `npm run build`):
 *   node docs/recordings/render-screenshots.mjs
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const CLI = path.join(REPO, "dist", "cli.js");
const FIXTURES = path.join(REPO, "test", "fixtures");
const ASSETS = path.join(REPO, "docs", "assets", "guides");

const STACKS = [
  { id: "angular", fixture: "angular-spa", friendlyPath: "~/projects/angular-spa" },
  { id: "react", fixture: "react-vite", friendlyPath: "~/projects/react-vite" },
  { id: "node", fixture: "node-express-ts", friendlyPath: "~/projects/express-api" },
  { id: "python", fixture: "python-fastapi-uvicorn", friendlyPath: "~/projects/fastapi-service" },
];

// ---- terminal chrome ------------------------------------------------------------------

function terminalHtml(title, bodyText) {
  const escaped = bodyText
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #0d1117; overflow: hidden; }
  .window {
    font-family: "Cascadia Mono", "SF Mono", Consolas, "Liberation Mono", Menlo, monospace;
    margin: 18px;
    border-radius: 10px;
    overflow: hidden;
    box-shadow: 0 10px 30px rgba(0,0,0,0.45);
    border: 1px solid #30363d;
  }
  .titlebar {
    background: #161b22;
    padding: 10px 14px;
    display: flex;
    align-items: center;
    gap: 8px;
    border-bottom: 1px solid #30363d;
  }
  .dot { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
  .dot.red { background: #ff5f56; }
  .dot.yellow { background: #ffbd2e; }
  .dot.green { background: #27c93f; }
  .titletext {
    color: #8b949e;
    font-size: 13px;
    margin-left: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .body {
    background: #0d1117;
    color: #c9d1d9;
    font-size: 14px;
    line-height: 1.5;
    padding: 18px 22px;
    white-space: pre-wrap;
    word-break: break-word;
    tab-size: 2;
  }
  .body .ok { color: #3fb950; }
  .body .prompt { color: #58a6ff; }
</style></head>
<body>
  <div class="window">
    <div class="titlebar">
      <span class="dot red"></span><span class="dot yellow"></span><span class="dot green"></span>
      <span class="titletext">${title}</span>
    </div>
    <div class="body">${escaped}</div>
  </div>
</body></html>`;
}

// ---- browser discovery ------------------------------------------------------------------

function findBrowser() {
  const candidates =
    process.platform === "win32"
      ? [
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
        ]
      : process.platform === "darwin"
        ? [
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
            "/Applications/Chromium.app/Contents/MacOS/Chromium",
          ]
        : ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge"];
  for (const c of candidates) {
    if (path.isAbsolute(c)) {
      if (fs.existsSync(c)) return c;
    } else {
      const r = spawnSync(process.platform === "win32" ? "where" : "which", [c]);
      if (r.status === 0) return c;
    }
  }
  throw new Error("No Chromium-based browser found (looked for Chrome/Edge/Chromium). Install one, or add its path to STACKS in this script.");
}

function toFileUrl(p) {
  const abs = path.resolve(p).replace(/\\/g, "/");
  return "file:///" + (abs.startsWith("/") ? abs.slice(1) : abs);
}

function screenshot(browser, htmlPath, pngPath, width, height) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "dls-shot-profile-"));
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    `--screenshot=${pngPath}`,
    toFileUrl(htmlPath),
  ];
  const r = spawnSync(browser, args, { encoding: "utf8", timeout: 30000 });
  fs.rmSync(profile, { recursive: true, force: true });
  if (r.status !== 0 || !fs.existsSync(pngPath)) {
    throw new Error(`screenshot failed for ${pngPath}\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  }
}

// ---- CLI capture ------------------------------------------------------------------------

function run(args, cwd) {
  const r = spawnSync(process.execPath, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1", DISTROLESS_SETUP_ASCII: "1", FORCE_COLOR: "" },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 60000,
  });
  return (r.stdout ?? "") + (r.stderr ?? "");
}

/**
 * Copies a fixture into a temp dir, keeping the fixture's own folder name (not a random
 * mkdtemp suffix): the Python stack falls back to the containing folder's name for the
 * image tag when no pyproject.toml `name` is set, and a random suffix would leak into
 * the screenshot.
 */
function copyFixture(name) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "dls-shot-"));
  const dest = path.join(parent, name);
  fs.cpSync(path.join(FIXTURES, name), dest, { recursive: true });
  return dest;
}

// ---- slicing --------------------------------------------------------------------------

function between(text, startRe, endRe) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => startRe.test(l));
  if (start < 0) throw new Error(`start marker ${startRe} not found`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (endRe.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start, end).join("\n").replace(/\s+$/, "");
}

function heightFor(text, width, { minLines = 6 } = {}) {
  const charsPerLine = Math.floor((width - 44) / 8.4);
  let visualLines = 0;
  for (const line of text.split("\n")) visualLines += Math.max(1, Math.ceil(line.length / charsPerLine));
  return Math.min(2200, 110 + Math.max(minLines, visualLines) * 23);
}

// ---- main -----------------------------------------------------------------------------

function main() {
  const browser = findBrowser();
  console.log(`Using browser: ${browser}`);

  for (const st of STACKS) {
    const dryDir = copyFixture(st.fixture);
    const dry = run([CLI, st.id, dryDir, "--yes", "--dry-run"], dryDir).replace(/\r\n/g, "\n");
    const dryFriendly = dry.replace(/^(\s*repo\s+).*$/m, `$1${st.friendlyPath}`);

    const applyDir = copyFixture(st.fixture);
    run([CLI, st.id, applyDir, "--yes"], applyDir);
    const report = fs.readFileSync(path.join(applyDir, "DISTROLESS-MIGRATION.md"), "utf8").replace(/\r\n/g, "\n");

    const outDir = path.join(ASSETS, st.id);
    fs.mkdirSync(outDir, { recursive: true });

    const shots = [
      {
        name: "01-before-you-start",
        title: `npx distroless-setup ${st.id} — ${st.friendlyPath}`,
        text: "", // filled in below: banner + the "Before we start" panel
      },
      {
        name: "02-plan",
        title: `${st.id} — plan (nothing written yet)`,
        text: between(dryFriendly, /^-- Plan/, /^-- Dry run/),
      },
      {
        name: "03-dockerfile",
        title: `${st.id} — generated Dockerfile`,
        text: between(dryFriendly, /^# Generated by distroless-setup/, /^\+-- \* distroless-setup/),
      },
      {
        name: "04-summary",
        title: `${st.id} — dry run complete`,
        text: between(dryFriendly, /^\+-- \* distroless-setup/, /(?!)/), // never matches: runs to the end
      },
      {
        name: "05-verify",
        title: `${st.id} — DISTROLESS-MIGRATION.md: build, run, verify`,
        text: between(report, /^```bash$/, /^```$/).split("\n").slice(1).join("\n"),
      },
    ];

    // Screenshot 1 is simplest taken from the raw banner+panel block directly.
    const bannerEnd = dryFriendly.indexOf("\n\n", dryFriendly.indexOf("-- Scanning repo"));
    shots[0].text = dryFriendly.slice(0, bannerEnd >= 0 ? bannerEnd : 600).replace(/\s+$/, "");

    for (const shot of shots) {
      const htmlPath = path.join(os.tmpdir(), `dls-shot-${st.id}-${shot.name}.html`);
      const pngPath = path.join(outDir, `${shot.name}.png`);
      fs.writeFileSync(htmlPath, terminalHtml(shot.title, shot.text), "utf8");
      const width = shot.name === "01-before-you-start" ? 980 : 1300;
      screenshot(browser, htmlPath, pngPath, width, heightFor(shot.text, width));
      fs.rmSync(htmlPath, { force: true });
      console.log(`wrote ${path.relative(REPO, pngPath)}`);
    }

    fs.rmSync(path.dirname(dryDir), { recursive: true, force: true });
    fs.rmSync(path.dirname(applyDir), { recursive: true, force: true });
  }
}

main();
