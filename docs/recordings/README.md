# Regenerating the guide screenshots

The terminal screenshots referenced from [`docs/guides/`](../guides/) are not hand-made or
faked: each one is a real screenshot of the real, built CLI (`dist/cli.js`) running against a
copy of the matching `test/fixtures/` project. Two reproducible methods are committed here;
pick whichever your machine can run.

| File | Method | Needs |
|---|---|---|
| `render-screenshots.mjs` | Headless Chromium screenshot (`--headless=new --screenshot`) of a small HTML terminal mock-up filled with the CLI's real captured output | Node.js + a Chrome/Edge/Chromium install already on the machine — **nothing else** |
| `angular.tape`, `react.tape`, `node.tape`, `python.tape` | [VHS](https://github.com/charmbracelet/vhs) (Charm's terminal recorder), for an animated `.gif` of the same session | Go, `vhs`, `ttyd` and `ffmpeg` |

**`render-screenshots.mjs` is what actually produced the PNGs currently committed under
`docs/assets/guides/<stack>/`.** `ttyd` and `ffmpeg` (VHS's own runtime dependencies) have no
first-class Windows build, so the `.tape` scripts are kept for contributors on macOS/Linux
who have VHS installed and want an animated recording instead of static screenshots — they
are not required to reproduce what's committed today.

## Regenerating the committed screenshots (`render-screenshots.mjs`)

```bash
# from the repository root
npm run build      # compiles src/ -> dist/cli.js, which the script runs directly
node docs/recordings/render-screenshots.mjs
```

The script:

1. Copies each stack's integration fixture (`test/fixtures/angular-spa`, `react-vite`,
   `node-express-ts`, `python-fastapi-uvicorn`) into a temp directory — never the fixture in
   place, so `test/fixtures/` always stays pristine for the test suite.
2. Runs `dist/cli.js <stack> <tmpdir> --yes --dry-run` (and a second, applied run to read the
   generated `DISTROLESS-MIGRATION.md`), with `NO_COLOR=1`/`DISTROLESS_SETUP_ASCII=1`, the
   same environment `test/integration/helpers.js` uses, so output is byte-for-byte
   reproducible across machines and fonts.
3. Slices that real output into five sections per stack — the "Before we start" panel, the
   file plan, the generated Dockerfile, the closing summary panel, and the
   `DISTROLESS-MIGRATION.md` build/run/verify commands — and renders each into a small,
   self-contained terminal-styled HTML page.
4. Screenshots each page with a local Chrome/Edge/Chromium in headless mode
   (`--headless=new --screenshot=<file>.png`) and writes straight into
   `docs/assets/guides/<stack>/`.

It auto-detects Chrome, Edge or Chromium at their default install locations on Windows,
macOS and Linux; if none is found it prints where it looked. No `npm install` is needed —
the script has no dependencies beyond Node's own `node:child_process` and `node:fs`.

## Regenerating an animated recording (VHS)

```bash
# VHS itself (needs Go, or use one of the package-manager installs in its README)
go install github.com/charmbracelet/vhs@latest

# ttyd and ffmpeg are VHS's own runtime dependencies
# macOS:   brew install ttyd ffmpeg
# Linux:   see https://github.com/charmbracelet/vhs#installation

npm run build
cp -r test/fixtures/angular-spa /tmp/vhs-angular-spa
export CLI="$(pwd)/dist/cli.js"
cd docs/recordings
vhs angular.tape   # writes ../assets/guides/angular/dry-run.gif
```

Each `.tape` script's header comment has the exact fixture-copy command for that stack. None
of the four are wired into the guides today (the guides embed the PNGs from
`render-screenshots.mjs`); add a `![...]` reference to the `.gif` in the relevant guide if
you generate one and want to use it instead of, or alongside, the static screenshots.

## Keeping screenshots honest after a CLI change

If you change a prompt's wording, a default value, a generated file's content, or a
section heading, the docs need to change too — the guides quote real CLI output, not
paraphrases. After such a change:

1. `npm run build`
2. `node docs/recordings/render-screenshots.mjs`
3. `git diff` the regenerated PNGs (or just re-read them) and the matching guide's fenced
   code blocks — both should describe the same thing.

## Why not just paste screenshots by hand?

A hand-taken screenshot goes stale silently: nothing fails when a prompt's wording changes,
so the doc quietly starts lying. A committed, runnable script is a spec of what the terminal
session should look like — regenerating it after a change is one command, and the script
itself is reviewable in a pull request the same way code is.
