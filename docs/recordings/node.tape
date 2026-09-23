# Regenerates docs/assets/guides/node/dry-run.gif — see docs/recordings/README.md.
#
# Runs with --yes so the recording is deterministic (every answer is the detected
# default, the same ones documented in docs/guides/node.md).
#
# Prerequisites: `npm run build` in the repo root, and a fresh copy of
# test/fixtures/node-express-ts at /tmp/vhs-node-express-ts (never the fixture in place):
#
#   cp -r test/fixtures/node-express-ts /tmp/vhs-node-express-ts
#   export CLI=/path/to/distroless-setup/dist/cli.js
#   vhs node.tape

Output ../assets/guides/node/dry-run.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 750
Set Padding 20

Env NO_COLOR "1"
Env DISTROLESS_SETUP_ASCII "1"

Hide
Type "cd /tmp/vhs-node-express-ts && clear"
Enter
Show

Type "node $CLI node --yes --dry-run"
Sleep 500ms
Enter
Sleep 4s
