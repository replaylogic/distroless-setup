# Step-by-step guides

New to distroless containers? Not sure what one of the CLI's questions means? Start here.

Pick the stack you're migrating and follow the walkthrough from running `distroless-setup`
through building and verifying the resulting container:

- **[Angular walkthrough](angular.md)** — Angular 19+, the static Go server, and optional
  runtime configuration.
- **[React walkthrough](react.md)** — React + Vite (the primary path), plus notes for React
  Router SPA mode and Create React App.
- **[Node.js walkthrough](node.md)** — an Express/TypeScript service, plus notes for NestJS,
  Next.js, Fastify, Koa and Hono.
- **[Python walkthrough](python.md)** — a FastAPI service, plus notes for Flask, Django and
  the other dependency managers.

Each guide walks through one representative project end to end: what the tool asks, why it
asks it, what it generates, and how to build, run and verify the image locally.

## What these guides are

Step-by-step onboarding. Each one explains, in plain language, what every meaningful CLI
prompt is asking, what a sensible answer looks like, and what changes in the generated
`Dockerfile` and `DISTROLESS-MIGRATION.md` depending on how you answer. They also explain
container concepts (build stage, runtime image, read-only root filesystem, non-root UID,
and so on) the first time each one matters, on the assumption that you know your framework
but may be new to distroless images specifically.

## What they are not

A replacement for:

- the [root README](../../README.md) — the full reference and capability matrix for every
  stack, flag and generated file;
- your project's own generated **`DISTROLESS-MIGRATION.md`** — the report is specific to
  *your* repo and *your* answers; these guides describe the general shape;
- your framework's own documentation — Angular, React, Node.js and Python concepts that
  aren't specific to containerising them are only covered where they affect the migration;
- a production deployment architecture review — the guides get you to a working, verified
  local container. Sizing, networking, secrets management and multi-service architecture
  are yours to design.

## Before you start any of them

All four guides assume you can already run terminal commands and have at least passing
familiarity with Docker (`docker build`, `docker run`). If you're completely new to Docker
itself, read through one guide anyway — the container-specific terms (build stage, runtime
image, health check, non-root, read-only root filesystem, and so on) are explained the first
time they come up.

You'll need:

- Node.js 18.17+ to run `npx distroless-setup` (even for the Python guide — the CLI itself
  is a Node program; the project it sets up can use any toolchain);
- Docker, to build and run the generated image;
- `curl` (or a browser), to verify the running container.

Back to the [project README](../../README.md).
