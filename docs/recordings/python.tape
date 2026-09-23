# Regenerates docs/assets/guides/python/dry-run.gif — see docs/recordings/README.md.
#
# Runs with --yes so the recording is deterministic (every answer is the detected
# default, the same ones documented in docs/guides/python.md).
#
# Prerequisites: `npm run build` in the repo root, and a fresh copy of
# test/fixtures/python-fastapi-uvicorn at /tmp/vhs-python-fastapi-uvicorn (never the
# fixture in place):
#
#   cp -r test/fixtures/python-fastapi-uvicorn /tmp/vhs-python-fastapi-uvicorn
#   export CLI=/path/to/distroless-setup/dist/cli.js
#   vhs python.tape

Output ../assets/guides/python/dry-run.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 800
Set Padding 20

Env NO_COLOR "1"
Env DISTROLESS_SETUP_ASCII "1"

Hide
Type "cd /tmp/vhs-python-fastapi-uvicorn && clear"
Enter
Show

Type "node $CLI python --yes --dry-run"
Sleep 500ms
Enter
Sleep 4s
