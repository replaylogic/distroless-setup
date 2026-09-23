# Regenerates docs/assets/guides/angular/dry-run.gif — see docs/recordings/README.md.
#
# Runs with --yes so the recording is deterministic (every answer is the detected
# default, the same ones documented in docs/guides/angular.md) instead of depending on
# keystroke timing against interactive prompts.
#
# Prerequisites: `npm run build` in the repo root, and a fresh copy of
# test/fixtures/angular-spa at /tmp/vhs-angular-spa (never the fixture in place):
#
#   cp -r test/fixtures/angular-spa /tmp/vhs-angular-spa
#   vhs angular.tape
#
# Set CLI to the absolute path of this repo's dist/cli.js before running, e.g.:
#   export CLI=/path/to/distroless-setup/dist/cli.js

Output ../assets/guides/angular/dry-run.gif

Set Shell "bash"
Set FontSize 15
Set Width 1200
Set Height 900
Set Padding 20

Env NO_COLOR "1"
Env DISTROLESS_SETUP_ASCII "1"

Hide
Type "cd /tmp/vhs-angular-spa && clear"
Enter
Show

Type "node $CLI angular --yes --dry-run"
Sleep 500ms
Enter
Sleep 4s
