# Changelog

## Unreleased

### Documentation

- Added beginner-friendly, step-by-step walkthrough guides for every first-class stack
  (`docs/guides/angular.md`, `react.md`, `node.md`, `python.md`), each following a real
  fixture project from `npx distroless-setup <stack>` through build/run/verify. Linked from
  the root README's new "Step-by-step guides" section and from a `docs/guides/README.md`
  index.
- Added 20 real terminal screenshots (5 per stack) under `docs/assets/guides/<stack>/`,
  embedded in the matching guide, generated from the CLI's actual output — never
  hand-captured — by `docs/recordings/render-screenshots.mjs` (Node + a local headless
  Chrome/Edge, no extra install). `docs/recordings/*.tape` (VHS scripts) are also included
  as an animated-recording alternative for contributors with VHS installed.
- Added optional Buy Me a Coffee funding links (`.github/FUNDING.yml` and a small README
  section near the bottom, not in the header).

## 0.3.0

A feature release: static and client-rendered React applications, on the same hardened
static runtime the Angular stack already uses. SSR React frameworks are not supported.

### React stack (`npx distroless-setup react`)

- New `react` stack for apps whose production build is a folder with `index.html` and
  static assets. The image is a Node build stage, the Go static server, and
  `gcr.io/distroless/static-debian13:nonroot`: no Node.js, no `node_modules`, no shell,
  UID `65532` / GID `0`, read-only root, `/healthz`, graceful SIGTERM.
- **React + Vite** is the primary path. It is detected from a `vite` dependency, a
  `vite.config.*` file or a `vite build` script. `build.outDir`, `root` and `base` are read
  from the config's syntax tree without running it. If a value isn't a literal, the tool
  asks.
- **React Router framework, SPA mode:** `ssr: false` in `react-router.config.*` is served
  from `build/client`. If `ssr` is true, missing (React Router defaults to SSR) or dynamic,
  the tool explains why and aborts unless you confirm the client output is a complete
  static build.
- **Create React App:** a compatibility path for existing apps (`build/`). CRA is
  deprecated upstream and is documented as such.
- **Other React builders:** a generic path. It runs the `build` script and asks for the
  output directory, defaulting to `dist` or to the folder an existing nginx Dockerfile
  copied. It is never labelled as Vite.
- **Detection:** the stack needs React evidence. Vite alone isn't enough, and neither is a
  `react` dependency without a build and an `index.html`. Next.js stays with the Node stack
  and Angular workspaces stay with Angular. Remix and Gatsby are not claimed. React next to
  Express, Fastify, Koa, Hono or NestJS defers to Node. The Node stack's own detection is
  unchanged.
- **Client build-time variables:** the stack finds `import.meta.env.VITE_*` (dot, bracket
  and destructuring forms, plus `%VITE_*%` in `index.html`) and `process.env.REACT_APP_*`.
  The report states they are compiled into public JavaScript, so setting them on a running
  container does nothing. The Dockerfile declares an `ARG` for each one so
  `--build-arg` works. Names that look like credentials are the first action item. Vite
  built-ins (`MODE`, `BASE_URL`, `PROD`, `DEV`, `SSR`) are excluded.
- **Build context:** the `.dockerignore` uses Angular's hardening (`.env`, `.env.*`,
  `!.env.example`, `*.pem`) plus `*.key`. `.env` files the bundler would have read are
  listed in the report with the `--build-arg` alternative.
- **Base paths:** Vite `base`, CRA `homepage` and React Router `basename` are reported,
  never rewritten. The report says the ingress must strip the prefix.
- **Existing nginx setups:** `add_header` security headers are carried over, the `listen`
  / `EXPOSE` port is reused if it isn't privileged, and `try_files ... /index.html` is
  recognised. `proxy_pass` aborts under `--yes`. Other directives (auth, rewrites, TLS,
  `return`, `sub_filter`, rate limits) and `envsubst`/`sed` entrypoints are listed in the
  report. The nginx files are removed by default only when nothing like that was found.

### Shared static-SPA runtime

- The Go server, its generated config, the Dockerfile server and runtime stages, nginx
  analysis, and the header, port and server-directory questions moved from the Angular
  stack to `src/stacks/shared/static-spa/`. For the Angular fixture, every generated file
  and prompt is identical to 0.2.0 except the server's `main.go` (see below) and the
  version stamp.

### Fixed: year-long caching of unversioned assets

- The static server sent `Cache-Control: public, max-age=31536000, immutable` for every
  file with a static-asset extension, whether or not its name was content-hashed. For
  example, `favicon.ico` and `logo.svg` could be pinned in browsers for a year. Now only
  content-hashed names are immutable: Vite/Rollup/Rolldown and esbuild (Angular)
  `name-HASH.ext`, and webpack/CRA `name.HASH[.chunk].ext`. Other assets get `no-cache`
  and are revalidated. Missing assets are still a 404, never the SPA fallback. Angular
  images pick up the fix when the tool is re-run.

### Tests

- New `react-vite` integration fixture: React 19 + Vite 8 + TypeScript with
  `react-router` client routes, a real `vite build` inside `docker build`, and a lockfile.
  The container is checked for the build arg compiled into `index.html` and the bundle, a
  runtime env var having no effect, `.env.local` not reaching the build, deep routes,
  immutable hashed JS/CSS, a revalidated `favicon.svg`, a 404 for a missing hashed bundle,
  gzip, HEAD/405, security headers, uid/gid, forbidden binaries, health, `--read-only`
  and a clean SIGTERM exit.
- Go behaviour tests for the shared server (`test/static-server/`). They run in the
  integration suite with a local Go toolchain or the `golang` image, and cover the hashed
  name heuristic against Vite, Angular and CRA names, the cache policy, SPA fallback,
  404s, HEAD, 405, gzip, headers, path traversal and runtime config.
- Unit and generation tests (the real CLI with `--yes`, no Docker) for detection
  competition, React Router `ssr` parsing, Vite config parsing, client variable analysis,
  base paths, Create React App, generic builders, nginx migration and refusing Next.js.

## 0.2.0

A trust-and-reliability release. No new stacks, frameworks or capabilities: the point is
that the existing claims are now demonstrated rather than asserted.

### Container integration tests

- Added a Docker-backed integration suite (`npm run test:integration`). For each fixture it
  runs the real CLI, builds the generated Dockerfile with `docker build`, starts the image,
  and probes the running container **over a published port from outside**.
- Every covered image is checked for: a successful build; a reachable HTTP endpoint on the
  published port; the application process reporting uid `65532` / gid `0`; `sh`, `bash`,
  `npm`, `pip`, `curl` and `wget` all being unrunnable as an entrypoint; Docker reporting
  the container `healthy` via the generated `HEALTHCHECK`; and the container still working
  under `--read-only` with only the writable mounts the report documents.
- Fixtures: Angular SPA (Go static server + runtime config), Express/TypeScript on npm,
  the same service on pnpm, Next.js standalone, FastAPI + uvicorn, FastAPI + Gunicorn with
  the Uvicorn worker, Flask + Gunicorn, and Django + uv. Fixtures are driven by `--yes` and
  shaped so the detected default *is* the path under test, rather than scripting prompt
  answers.
- Django + uv proves the two build steps no other fixture reaches: a real
  `uv sync --frozen` install and `manage.py collectstatic --noinput` during `docker build`,
  then WhiteNoise serving the hashed asset that produced out of a read-only image.
- pnpm proves the alternative package-manager path: Corepack, `pnpm install
  --frozen-lockfile`, `pnpm prune --prod`, and pnpm's symlinked `node_modules` surviving
  the copy into the distroless stage.
- Angular coverage proves the differentiating behaviour end to end: SPA fallback, `/healthz`,
  immutable caching for hashed assets, 404 (not fallback) for a missing hashed asset,
  pre-compressed gzip, nginx headers carried over, and a config value changed by an
  environment variable on the *same image* with no rebuild.
- Also covered without Docker: `--dry-run` leaves every source file untouched and writes
  only the report; applying a plan backs up what it overwrites; re-running produces an
  identical Dockerfile and never reuses a previous run's backup directory.
- `npm test` still runs only the fast unit tests. CI runs the Docker suite once, on one
  Linux runner, instead of across the whole Node/OS matrix.

### Python / Uvicorn

- Gunicorn + Uvicorn now generates `-k uvicorn_worker.UvicornWorker` from the standalone
  `uvicorn-worker` package. Uvicorn deprecated the bundled `uvicorn.workers` module in 0.30
  and will remove it; generated images no longer depend on it.
- The required dependency for that server choice is now `uvicorn-worker`. A missing one is
  reported, optionally installed in the image, and always accompanied by an action item to
  pin it in your own dependency file.
- A project that already has `gunicorn` + `uvicorn-worker` but does not list `uvicorn`
  itself now defaults to the Gunicorn worker option instead of plain uvicorn.
- Source files that still reference `uvicorn.workers` are flagged in the report.

### Fixed

- **Two runs in the same second shared a backup directory**, so the second run copied over
  the first run's backups and the files as they were before *any* run were lost. Backup
  directories are now made unique (`<timestamp>`, `<timestamp>-2`, …).

### Filesystem safety

- `Plan` now refuses any write or removal that resolves outside the selected repository,
  whether through `..` in an answer or through a symlink (including a symlinked parent
  directory). Checked when the action is planned, so it fails before anything is written.
- `Plan.apply()` re-validates every path before touching the first file, and a failure
  part-way through now reports which files were already changed and where their backups
  are, instead of surfacing a bare `fs` error.

### Supply chain

- All GitHub Actions are pinned to full commit SHAs with the release tag in a trailing
  comment. Added a minimal Dependabot config for the `github-actions` ecosystem and a
  maintainer guide for updating pins by hand.
- The publish workflow moved to npm **trusted publishing** (OIDC): no `NODE_AUTH_TOKEN`,
  no long-lived npm token. It pins `npm@^11.5.1` (the minimum for trusted publishing, above
  what `actions/setup-node` ships), keeps `id-token: write`, keeps provenance, keeps the
  tag ↔ `package.json` version check, and now builds and tests before publishing.
  `RELEASING.md` documents the npm-side configuration that only the package owner can do.
- The publish workflow sets `package-manager-cache: false`, so a release resolves its
  dependencies from the registry rather than from a cache another workflow run populated.
  It also pins `actions/setup-node` to the v7 line deliberately: up to v6 the action
  exported a placeholder `NODE_AUTH_TOKEN` even with no token configured, which made npm
  skip the OIDC exchange and fail to publish (actions/setup-node#1440).
- The Angular `.dockerignore` recommendation now includes `.env`, `.env.*`,
  `!.env.example` and `*.pem`. The Angular build stage does `COPY . .`, so local secrets
  could previously reach a build-stage layer.
- `CHANGELOG.md` is included in the published package; the packed contents are otherwise
  unchanged (`dist/`, `README.md`, `LICENSE`).

### Documentation

- The headline no longer claims "a fraction of the CVEs". It describes what a distroless
  runtime actually gives you and says plainly that your own dependencies come along
  unchanged.
- Added a support and validation matrix separating what is implemented, what is unit
  tested, and what is proven by a container integration test — including why NestJS,
  Fastify, Koa and Hono are out, and spelling out that one proven Django + uv or pnpm
  fixture does not make every Django or pnpm configuration proven.
- `CONTRIBUTING.md` documents the test layout, the fixture convention and how to update
  pinned action SHAs.

### Other

- A unit test now fails if any version-bearing file drifts from `package.json`:
  `src/core/report.ts`'s `VERSION` (stamped into every generated file), both version fields
  in `package-lock.json`, and the `CHANGELOG.md` section heading.
- `package-lock.json` was still reporting `0.1.0`; regenerated with
  `npm install --package-lock-only`.

## 0.1.0

First public release.

- `angular`: Go static server on `distroless/static-debian13`; nginx header import and `proxy_pass` detection; optional runtime `config.json` with env-var overrides; generated Angular config service, provider wiring and AST-based rewriting of `environment` reads.
- `node`: Express, NestJS, Next.js (standalone or `next start`), Fastify, Koa, Hono and plain Node/TypeScript on `distroless/nodejs{22,24,26}-debian13`; npm, Yarn and pnpm.
- `python`: FastAPI, Flask, Django, Starlette and scripts on `distroless/python3-debian13`; pip, uv, Poetry and Pipenv; uvicorn, gunicorn, hypercorn, granian and waitress.
- Plan preview, diffs before code edits, backups, `--dry-run`, `--yes`, and a `DISTROLESS-MIGRATION.md` report.
