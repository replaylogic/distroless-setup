# distroless-setup

[![npm version](https://img.shields.io/npm/v/distroless-setup.svg)](https://www.npmjs.com/package/distroless-setup)
[![npm downloads](https://img.shields.io/npm/dm/distroless-setup.svg)](https://www.npmjs.com/package/distroless-setup)
[![CI](https://github.com/replaylogic/distroless-setup/actions/workflows/ci.yml/badge.svg)](https://github.com/replaylogic/distroless-setup/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/distroless-setup.svg)](LICENSE)

Move an **Angular**, **Node.js** or **Python** app to a [distroless](https://github.com/GoogleContainerTools/distroless) container image: no shell, no package manager, non-root, a fraction of the CVEs.

```bash
npx distroless-setup
```

It looks at your repo, asks a few questions (every one has a sensible default), shows you exactly what it will change, and only writes after you confirm. Every file it overwrites is backed up first, and it finishes with a `DISTROLESS-MIGRATION.md` report listing what was done and what is left for you.

| Stack | What you get |
|---|---|
| **Angular 19+** | A tiny static Go server on `distroless/static` replaces nginx. Optional runtime config: `config.json` values overridden by env vars, so one image runs in every environment without a rebuild. |
| **Node.js** — Express, NestJS, Next.js, Fastify, plain Node/TypeScript | A Debian build stage (install, build, drop dev dependencies) and a `distroless/nodejs` runtime. Next.js uses `output: 'standalone'`. |
| **Python** — FastAPI, Flask, Django, plain scripts; pip, uv, Poetry, Pipenv | A virtualenv built against the runtime's own Python, copied into `distroless/python3`, served by uvicorn / gunicorn / hypercorn / granian / waitress. |

## Usage

There are two ways to point it at a project — pick whichever fits, they're not sequential steps:

**Let it detect the stack:**

```bash
npx distroless-setup
```

It looks at the current folder, tells you what it found, and asks you to confirm before it does anything else. Nothing changes if you say no.

**Or name the stack up front** — same tool, same confirmation step, just skips detection:

```bash
npx distroless-setup node ./services/api
npx distroless-setup python
npx distroless-setup angular
```

Either form takes the same flags:

```bash
npx distroless-setup --dry-run          # detect, but only show the plan and write the report
npx distroless-setup python --dry-run   # named stack + dry run
npx distroless-setup angular --yes      # named stack, accept every default (CI, scripted runs)
```

| Option | |
|---|---|
| `angular` \| `node` \| `python` | Optional. Names the stack and skips detection. Aliases: `nest`, `next`, `express`, `fastapi`, `django`, `flask`. Leave it out to auto-detect instead. |
| `-n`, `--dry-run` | Print the plan and the generated Dockerfile; write only `DISTROLESS-MIGRATION.md`, marked as a dry run. |
| `-y`, `--yes` | Use every default without prompting. |
| `-h`, `--help` / `-v`, `--version` | |

Requires Node.js 18.17 or newer on the machine that runs the tool, even for Python projects. The project itself can use any toolchain.

## Is it safe to run on my repo?

- **Nothing is written until you approve the plan**, which lists every file as `CREATE`, `UPDATE` or `REMOVE` with the reason.
- **Code edits are shown as a diff first** and need their own confirmation.
- **Backups:** every file it updates or removes is copied to `.distroless-backup/<timestamp>/` first (and it offers to add that folder to `.gitignore`).
- **Re-runnable:** running it again regenerates its own files and keeps your earlier choices (for example, custom security headers). It doesn't duplicate imports or providers.
- **No network, no telemetry.** It reads your files and writes files; it doesn't build images or call anything.

Commit or stash first anyway, so `git diff` shows you the whole change.

## What gets generated

**Always:** a multi-stage `Dockerfile`, a `.dockerignore` (created, or fixed if it would exclude files the build needs), and `DISTROLESS-MIGRATION.md`.

Every runtime image:

- runs as UID `65532` with group `0`, so it works on Kubernetes and on OpenShift's arbitrary UIDs;
- listens on a non-privileged port;
- has a `HEALTHCHECK` that needs no shell or curl (Node uses `fetch`, Python uses `urllib`, Angular uses the server binary itself);
- is compatible with `readOnlyRootFilesystem: true` (the report lists any folder that needs a volume).

### Angular

- `server/` holds the Go static server source (`main.go`, `go.mod`, `zz_generated_config.go`). It is compiled in the Dockerfile, so you don't need Go installed. It serves hashed assets with long-lived caching, `index.html` with `no-cache`, a SPA fallback, gzip, your security headers, and `/healthz`.
- nginx configs and entrypoint scripts that the server replaces are removed (after asking).
- `nginx.conf` security headers are carried over. `proxy_pass` is detected and flagged, because a static server can't proxy.

**Runtime config (optional).** If the app reads settings from `environment.ts`, the tool can move them to a `config.json` that the app loads before bootstrap:

- `_runtime-config.model.ts` and `_runtime-config.service.ts` are generated with `provideRuntimeConfig()`, `runtimeConfig()`, `RuntimeConfigService` and `setRuntimeConfigForTesting()`. The distinctive name avoids clashing with config code you already have.
- The provider is added to `app.config.ts` (or your root NgModule) after showing you the diff.
- Reads such as `environment.apiUrl` are rewritten to `runtimeConfig().apiUrl`, **but only where the TypeScript syntax tree shows the code runs after bootstrap** (inside functions, methods, constructors, instance fields). Reads at module level, in decorators, in static fields or in the bootstrap config are left alone and listed with a suggested fix.
- Nested objects can be flattened (`auth.clientId` → `AUTH_CLIENT_ID`) or kept as one JSON-valued env var.
- Per-configuration files (`config.staging.json`, …) are generated from your `fileReplacements`.

In the container, set `USE_RUNTIME_CONFIG=true` and any of the env vars. Keys whose env var is unset keep their build-time value, and nothing is written to disk.

Angular 19+ is required for the runtime-config part (it uses `provideAppInitializer`). Older apps can still get the image-only setup.

### Node.js

- **Next.js:** offers to add `output: 'standalone'` to `next.config.*` (shown as a diff). The image then contains only the traced server files, and runs `node server.js`. If you decline, it runs `next start` on production `node_modules` instead. `NEXT_PUBLIC_*` variables are flagged, because `next build` inlines them, so setting them on the container does nothing.
- **NestJS / Express / others:** the entry file is found from your `start:prod` / `start` scripts, `nest-cli.json`, `tsconfig` `outDir` or `main`. The runtime image gets `node_modules` (production only), `package.json` and your build output.
- The distroless Node image's entrypoint *is* `node`, so there is no `npm start` at runtime; `CMD` names the script. The report explains what to do with anything your start script did beyond that.

Checks included in the report:

- Missing SIGTERM handling (Node runs as PID 1).
- A hard-coded listen port.
- A missing health endpoint (with a snippet for your framework).
- `process.env` variables the app reads.
- `.npmrc` tokens (with the BuildKit secret alternative).
- Code that shells out.
- Dependencies that need system libraries distroless doesn't have, such as Puppeteer, Playwright and `canvas`.

npm, Yarn (classic and Berry) and pnpm are supported, with corepack.

### Python

- Follows the [official distroless pattern](https://github.com/GoogleContainerTools/distroless/tree/main/examples/python3-requirements). The venv is built on `python:3.13-slim-trixie`, with `/usr/bin/python` linked to the path the runtime provides, so the venv works unchanged in `distroless/python3-debian13`.
- **Dependencies:**
  - `uv sync --frozen` (uv never downloads its own Python here).
  - `poetry install --only main`.
  - `pipenv requirements` → pip.
  - `pip install -r` (you pick the production requirements file).
  - `pip install .`
- **App discovery:** finds `FastAPI()` / `Flask()` / `Starlette()` objects, Flask `create_app()` factories, and Django's WSGI module from `manage.py`. `src/` layouts get `PYTHONPATH`.
- **Server:** uses the one in your dependencies, or offers to install one and tells you to pin it. Gunicorn keeps its worker heartbeat in `/dev/shm`, so it runs on a read-only root.
- **Django:** `collectstatic` runs at build time. Migrations are pointed at a Job or init container, and WhiteNoise is suggested if nothing serves static files.
- **Checks:**
  - Dependencies that need system libraries: `psycopg2` (vs `psycopg2-binary`), `mysqlclient`, `python-ldap`, `weasyprint`, `opencv-python`, and others.
  - `shell=True` / `os.system`.
  - Env vars read via `os.environ`, `os.getenv`, django-environ or python-decouple.

**Python version:** distroless publishes one Python, **3.13** (Debian 13). If `requires-python`, `.python-version` or similar pins a different version, the tool says so up front. Test on 3.13 before you ship.

## Image versions

Defaults, as published by distroless at the time of this release (Debian 13 "trixie"):

| Stack | Runtime | Build stage |
|---|---|---|
| Angular | `gcr.io/distroless/static-debian13:nonroot` | `node:<your major>-alpine`, `golang:1-alpine` |
| Node.js | `gcr.io/distroless/nodejs{22,24,26}-debian13:nonroot` | `node:<major>-trixie-slim` |
| Python | `gcr.io/distroless/python3-debian13:nonroot` | `python:3.13-slim-trixie` |

Node and Python build stages are Debian trixie on purpose. Native modules compiled on Alpine (musl) crash on the glibc-based runtime.

Every image is a prompt, so you can point it at a registry mirror. You can also paste a `sha256:` digest to pin it; the report explains how to get the digest and automate updates.

## After running it

Open `DISTROLESS-MIGRATION.md`. **Action required** is the ordered to-do list for your repo, for example:

- register a provider it couldn't wire;
- fix environment reads that run too early;
- add a health endpoint;
- handle SIGTERM;
- pin the digest.

It also has the build/run/verify commands, a Kubernetes/OpenShift `securityContext` and probes, and every CI file that still mentions nginx or shell tools.

```bash
docker build -t myapp:distroless .
docker run --rm -p 8080:8080 myapp:distroless
```

## Debugging a distroless image

A distroless runtime has no shell, no package manager and no coreutils, so `docker exec -it ... sh` won't work. Logs and everything else you need are still available:

**Logs.** No change needed — all three stacks are set up to log to stdout/stderr, so `docker logs <container>` and `kubectl logs <pod>` work exactly as normal. This doesn't require a shell inside the image at all.

**A shell for interactive debugging**, in order of preference:

| Situation | Command |
|---|---|
| Docker Desktop, local | `docker debug <container>` — attaches a debug toolbox to a running container without modifying the image |
| Kubernetes / OpenShift | `kubectl debug -it <pod> --image=busybox --target=<container>` — attaches an ephemeral container sharing the pod's process namespace, so `/proc/<pid>/root` is the target's filesystem |
| Inspect files without a shell | `docker cp <container>:/path ./local-path` — works against a stopped or running container |
| Compose / local, need it often | Build a `-debug` variant of your image on `gcr.io/distroless/*-debug` (busybox + shell) for local troubleshooting; keep the production tag on the non-debug base |

`DISTROLESS-MIGRATION.md` fills in the exact `docker debug` / `kubectl debug` invocation for the image just generated, plus the health-check and probe commands for your stack.

## Limitations

- One service per run. In a monorepo, run it in each service's folder.
- Angular SSR isn't served. The static browser build is; for SSR, containerise the server bundle with the `node` stack.
- Next.js `output: 'export'` sites are detected but not handled yet. They need only a static server.
- Detection is static analysis, not execution. The tool shows what it found and asks before relying on it. Anything it can't decide safely goes in the report instead of being changed.
- It generates a Dockerfile but doesn't build it. Build and test the image in your normal pipeline.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## License

MIT — see [LICENSE](LICENSE).
