# Releasing

Publishing is automated: pushing a `v*` tag runs `.github/workflows/publish.yml`, which
verifies the tag against `package.json`, builds, tests, and publishes to npm.

Authentication uses **npm trusted publishing** (OIDC). The workflow holds no npm token.

## One-time setup on npmjs.com (repository owner only)

The repository cannot configure its own trusted-publisher relationship: npm has to be told
which workflow, in which repository, is allowed to publish. Until this is done, the publish
job will fail with an authentication error.

1. Sign in to <https://www.npmjs.com> as an owner of `distroless-setup`.
2. Go to the package → **Settings** → **Trusted publishers** → **Add publisher**.
3. Choose **GitHub Actions** and fill in:

   | Field | Value |
   |---|---|
   | Organization or user | `replaylogic` |
   | Repository | `distroless-setup` |
   | Workflow filename | `publish.yml` — the filename only, not a path |
   | Environment name | leave blank (the workflow uses no GitHub environment) |

4. Save.

Notes:

- npm requires **npm CLI ≥ 11.5.1 and Node ≥ 22.14** for trusted publishing.
  `actions/setup-node` with Node 22 still ships npm 10, so the workflow installs
  `npm@^11.5.1` explicitly before publishing. Keep that step if you change the Node version.
- **Do not downgrade `actions/setup-node` below v7.** Up to v6 it exported a placeholder
  `NODE_AUTH_TOKEN` even with no token configured; npm then treated auth as already set up,
  never performed the OIDC exchange, and publishing failed with a 404
  ([actions/setup-node#1440](https://github.com/actions/setup-node/issues/1440)). If a
  Dependabot PR ever moves that pin backwards, reject it.
- Provenance is generated automatically for trusted publishes. The workflow still passes
  `--provenance` so that a misconfiguration fails loudly rather than publishing a package
  without an attestation. `id-token: write` is required for both and must stay.
- If publishing is ever configured as *staged*, the release is not live until it is
  promoted from the npm UI. Configurations created from September 2026 default to allowing
  staged publishes; choose whether direct `npm publish` is also permitted when adding the
  publisher.

## After trusted publishing works

The `NPM_TOKEN` repository secret is no longer used by any workflow and should be deleted
(**Settings → Secrets and variables → Actions**), and the matching token revoked on npm
(**Access Tokens**). A long-lived publish token that nothing uses is pure risk.

If you still need a token for anything (for example a local `npm publish` fallback), make
it a **granular, read-only** token rather than a publish token.

## Cutting a release

```bash
# 1. Land everything, on main, with a green CI run.
npm ci
npm run test:all          # unit tests + the Docker integration suite

# 2. Bump the version. src/core/report.ts stamps this into every generated file,
#    so the two must match.
#    - package.json  "version"
#    - src/core/report.ts  VERSION
#    - CHANGELOG.md  new section

npm run build
npm test
npm pack --dry-run        # confirm only dist/, README, CHANGELOG and LICENSE are packed

# 3. Tag and push. The tag must equal "v" + package.json version, or publish fails.
git commit -am "Release v0.2.0"
git tag v0.2.0
git push origin main --tags
```

Then watch the `publish` workflow. On success the release is on npm with provenance
linking it back to the commit and workflow run that built it.
