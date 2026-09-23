# Regenerates docs/assets/guides/react/dry-run.gif — see docs/recordings/README.md.
#
# Runs with --yes so the recording is deterministic (every answer is the detected
# default, the same ones documented in docs/guides/react.md).
#
# Prerequisites: `npm run build` in the repo root, and a fresh copy of
# test/fixtures/react-vite at /tmp/vhs-react-vite (never the fixture in place):
#
#   cp -r test/fixtures/react-vite /tmp/vhs-react-vite
#   export CLI=/path/to/distroless-setup/dist/cli.js
#   vhs react.tape

Output ../assets/guides/react/dry-run.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 800
Set Padding 20

Env NO_COLOR "1"
Env DISTROLESS_SETUP_ASCII "1"

Hide
Type "cd /tmp/vhs-react-vite && clear"
Enter
Show

Type "node $CLI react --yes --dry-run"
Sleep 500ms
Enter
Sleep 4s
