# Changelog

## 0.1.0

First public release.

- `angular`: Go static server on `distroless/static-debian13`; nginx header import and `proxy_pass` detection; optional runtime `config.json` with env-var overrides; generated Angular config service, provider wiring and AST-based rewriting of `environment` reads.
- `node`: Express, NestJS, Next.js (standalone or `next start`), Fastify, Koa, Hono and plain Node/TypeScript on `distroless/nodejs{22,24,26}-debian13`; npm, Yarn and pnpm.
- `python`: FastAPI, Flask, Django, Starlette and scripts on `distroless/python3-debian13`; pip, uv, Poetry and Pipenv; uvicorn, gunicorn, hypercorn, granian and waitress.
- Plan preview, diffs before code edits, backups, `--dry-run`, `--yes`, and a `DISTROLESS-MIGRATION.md` report.
