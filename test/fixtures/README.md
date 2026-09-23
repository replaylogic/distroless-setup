# Integration fixtures

Small, real projects used by `test/integration/`. Each one exists because it exercises a
**materially different runtime path**, not because it covers another framework name.

| Fixture | What is different about it |
|---|---|
| `node-express-ts` | TypeScript compiled by `tsc`, production dependency prune, entry point found from `start:prod`, SIGTERM handling |
| `node-express-ts-pnpm` | The same service on pnpm: Corepack, `pnpm install --frozen-lockfile`, `pnpm prune --prod`, symlinked `node_modules` crossing the stage boundary |
| `node-next` | Next.js `output: 'standalone'`, traced server, `public/`, a writable cache path under a read-only root |
| `python-fastapi-uvicorn` | ASGI served directly by uvicorn, pip + `requirements.txt` |
| `python-fastapi-gunicorn` | Gunicorn process manager with the `uvicorn_worker.UvicornWorker` class |
| `python-flask-gunicorn` | WSGI, Gunicorn's default sync worker |
| `python-django-uv` | uv (`uv sync --frozen`), Django WSGI discovery from `manage.py`, `collectstatic` during the build, WhiteNoise serving the result |
| `angular-spa` | Generated Go static server, AST-rewritten `environment` reads, runtime config from env vars, per-configuration config via `fileReplacements` |

## The one rule

**The tests run the CLI with `--yes`, so every answer is the detected default.**

That means a fixture has to be shaped so the default *is* the path being tested. For
example, `python-fastapi-gunicorn` lists both `gunicorn` and `uvicorn-worker` in
`requirements.txt`, which is what makes "gunicorn + uvicorn workers" the default server
choice; `python-fastapi-uvicorn` lists neither, so plain uvicorn wins.

Do not script answers into stdin instead. Answer scripts break every time a prompt is
reworded, and they test the prompt order rather than the detection logic. If you cannot
reach a path by shaping the fixture, that is usually a sign the detection default is wrong.

## Other conventions

- Every HTTP fixture exposes a health endpoint that returns its own `uid` and `gid`. That
  is how the suite proves the process really runs as `65532:0` from outside the container,
  without needing a shell inside it.
- Every fixture commits a real lockfile or exact pins, so image builds are reproducible:
  `package-lock.json` (regenerate with `npm install --package-lock-only`),
  `pnpm-lock.yaml` (`pnpm install --lockfile-only`), `uv.lock` (`uv lock`), or exact
  versions in `requirements.txt`.
- Fixtures are copied to a temp directory before the CLI touches them, so running the suite
  never modifies anything in this folder.
