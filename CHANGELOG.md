# Changelog

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
