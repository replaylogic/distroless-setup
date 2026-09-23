# Security Policy

`distroless-setup` exists to reduce the attack surface of container images, so we take
security issues in the tool itself seriously — both in the CLI and in the Dockerfiles,
server code, and configuration it generates for your project.

## Supported versions

Only the latest published version on npm is supported. Fixes go out as a new patch or
minor release rather than being backported.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security reports.**

Instead, use GitHub's private reporting:

1. Go to the [Security tab](https://github.com/replaylogic/distroless-setup/security) of this repository.
2. Click **Report a vulnerability**.
3. Include what you found, the version affected, and steps to reproduce (a minimal
   project + the exact `distroless-setup` command is ideal).

If GitHub private reporting isn't available to you, open a regular issue asking for a
contact channel — without details of the vulnerability — and a maintainer will follow up.

We aim to acknowledge reports within 5 business days.

## What's in scope

- The CLI itself: how it detects, plans, and writes files.
- Generated artifacts: Dockerfiles, the Angular static server (`server/main.go`), health
  checks, and any runtime-config code it writes.
- Supply-chain issues in `distroless-setup`'s own dependencies.

## What's out of scope

- Vulnerabilities in the base images `distroless-setup` builds on top of
  (`gcr.io/distroless/*`) — please report those upstream at
  [GoogleContainerTools/distroless](https://github.com/GoogleContainerTools/distroless/security).
- Vulnerabilities in your own application code that the tool migrates unchanged.
- CVEs in a pinned build-stage image (e.g. `node:<major>-trixie-slim`) — these move as
  upstream publishes patched tags; re-running the tool or rebuilding picks up newer digests.

## Disclosure

We'll coordinate a fix and a release before any public disclosure, and credit reporters
in the release notes unless you'd prefer to stay anonymous.
