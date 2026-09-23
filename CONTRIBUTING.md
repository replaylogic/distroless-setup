# Contributing to distroless-setup

Thanks for taking the time to contribute.

## Getting set up

```bash
git clone https://github.com/replaylogic/distroless-setup.git
cd distroless-setup
npm install
npm run build         # compiles src/ (TypeScript) -> dist/
npm test              # builds, then runs the unit tests with node --test
npm run test:integration  # builds real images from fixtures and runs them (needs Docker)
npm run test:all      # both
```

`npm test` is the fast loop and needs nothing but Node. `npm run test:integration` needs a
running Linux Docker daemon; it generates Dockerfiles from `test/fixtures/`, builds the
images, runs them and probes them over a published port. Without Docker those tests report
as skipped rather than failing, so you can still run `npm run test:all` locally.

Only Docker is required to *run* the suite. Regenerating a fixture's lockfile needs that
fixture's own tool (`npm`, `pnpm` or `uv`) — see [test/fixtures/README.md](test/fixtures/README.md).

Try the CLI against a real project without touching it:

```bash
node dist/cli.js --dry-run /path/to/an/app
```

`--dry-run` prints the plan and generated Dockerfile and writes only
`DISTROLESS-MIGRATION.md`, so it's the fastest way to see what a change to the tool
actually produces.

## Project layout

| Path | What's there |
|---|---|
| `src/cli.ts` | Entry point: argument parsing, stack selection, top-level flow |
| `src/core/` | Shared plumbing — file planning, diffing/backups, the prompter, report rendering |
| `src/stacks/` | One module per stack (`angular`, `react`, `node`, `python`) — detection, Dockerfile generation, stack-specific checks. `src/stacks/shared/static-spa/` holds the Go static server and the questions the Angular and React stacks share; `src/stacks/index.ts` is the registry |
| `test/unit.test.js` | Unit tests for parsers, analysis and the change plan |
| `test/fixtures/` | Small real projects, one per materially different runtime path |
| `test/integration/` | Docker-backed tests: run the CLI, build the image, run it, probe it |
| `docs/guides/` | Beginner-friendly, per-stack walkthroughs (see [docs/guides/README.md](docs/guides/README.md)) |
| `docs/recordings/` | Scripts that reproduce the guides' terminal screenshots from source: `render-screenshots.mjs` (Node + headless Chrome, no extra install — what actually produced the committed screenshots) and VHS `.tape` scripts for an animated alternative |

If you change what a prompt asks, what it defaults to, or what the generated `Dockerfile`
looks like, check whether the matching `docs/guides/<stack>.md` quotes that prompt or output
verbatim — if it does, update it and run `node docs/recordings/render-screenshots.mjs` to
regenerate the matching screenshots too (see that folder's README).

## Making a change

- Keep stack-specific logic inside `src/stacks/<stack>/`; shared logic belongs in `src/core/`.
- If you change what gets written to a user's repo, update the relevant section of
  `README.md` and add a `CHANGELOG.md` entry under an `Unreleased` heading.
- Add or update a unit test for the behavior you changed. `npm test` builds first, so it
  always runs against compiled output, matching what ships.
- If you change what the generated Dockerfile *does* at runtime, add or extend an
  integration test rather than a Dockerfile-text snapshot. The bar is "the image built,
  ran and served a request", not "the text looks right".
- Fixtures are driven by `--yes`, so every answer is the detected default. Shape the
  fixture so the default *is* the path you want to test, instead of scripting stdin;
  that keeps the tests from breaking whenever a prompt is reworded.
- Nothing should be written to disk in tests or examples without going through the same
  plan → confirm → backup path the CLI itself uses.

## Updating pinned GitHub Actions

Every third-party action in `.github/workflows/` is pinned to a full commit SHA, with the
release tag in a trailing comment:

```yaml
- uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
```

A tag can be moved to a different commit; a SHA cannot, so this is what stops a
compromised or retagged action from silently entering a build. Dependabot
(`.github/dependabot.yml`) raises a monthly PR that updates both the SHA and the comment.

To update one by hand, resolve the tag you want and paste the commit SHA:

```bash
gh api repos/actions/checkout/git/ref/tags/v7.0.1 --jq .object.sha
```

Check that `.object.type` is `commit`. For an annotated tag it is `tag`, and you need the
commit it points at (`gh api repos/<owner>/<repo>/git/tags/<sha> --jq .object.sha`).
GitHub-hosted runner labels such as `ubuntu-latest` are deliberately *not* pinned.

## Bug reports

Most useful with:

- The exact command you ran and its `--dry-run` output.
- The kind of project: framework and version, package manager, Node/Python version.
- What you expected vs. what happened.

## Pull requests

- Fork, branch from `main`, and keep the change focused — separate PRs for unrelated fixes.
- `npm test` must pass; CI also smoke-tests the packed CLI (`npm pack` → global install →
  `--version`/`--help`) on Linux, macOS and Windows across supported Node versions.
- Describe what changed and why in the PR description; link any related issue.

## CI behavior

A `classify` job runs first and decides whether the rest of the pipeline needs to run. A
change that touches only documentation/support paths (`docs/**`, `README.md`,
`CONTRIBUTING.md`, `CHANGELOG.md`, `SECURITY.md`, `.github/FUNDING.yml`, and similar —
see `.github/scripts/classify-ci-changes.sh` for the exact list) skips the unit matrix and
Docker integration tests. Any other change, including a mix of docs and product files, an
unrecognized path, or a change to CI config itself, runs the full suite. `ci-success` — the
required branch-protection check — always runs and reflects this: it passes on a
documentation-only PR once classification succeeds, and otherwise requires both the unit
matrix and the integration job to succeed.

## Security issues

Please don't file a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
