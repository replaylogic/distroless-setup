# Contributing to distroless-setup

Thanks for taking the time to contribute.

## Getting set up

```bash
git clone https://github.com/replaylogic/distroless-setup.git
cd distroless-setup
npm install
npm run build     # compiles src/ (TypeScript) -> dist/
npm test           # builds, then runs the unit tests with node --test
```

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
| `src/stacks/` | One module per stack (`angular`, `node`, `python`) — detection, Dockerfile generation, stack-specific checks |
| `test/` | Unit tests (`node --test`) |

## Making a change

- Keep stack-specific logic inside `src/stacks/<stack>/`; shared logic belongs in `src/core/`.
- If you change what gets written to a user's repo, update the relevant section of
  `README.md` and add a `CHANGELOG.md` entry under an `Unreleased` heading.
- Add or update a unit test for the behavior you changed. `npm test` builds first, so it
  always runs against compiled output, matching what ships.
- Nothing should be written to disk in tests or examples without going through the same
  plan → confirm → backup path the CLI itself uses.

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

## Security issues

Please don't file a public issue for a vulnerability — see [SECURITY.md](SECURITY.md).
