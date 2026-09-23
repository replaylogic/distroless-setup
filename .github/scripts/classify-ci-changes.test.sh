#!/usr/bin/env bash
# Exercises classify-ci-changes.sh against the representative scenarios from
# the CI docs-only-skip design. Pure git + bash, no network access, no
# dependency on the actual repository history.
#
# Run manually with:
#   bash .github/scripts/classify-ci-changes.test.sh
# or automatically as a step in the `classify` CI job, before that job
# trusts the script to classify the real event.

set -u
set -o pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLASSIFY="$SCRIPT_DIR/classify-ci-changes.sh"

WORK="$(mktemp -d)"
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

repo="$WORK/repo"
mkdir -p "$repo"
cd "$repo" || exit 1
git init -q
git config user.email "classify-test@example.com"
git config user.name "classify-test"
git commit -q --allow-empty -m base
BASE_SHA="$(git rev-parse HEAD)"

status=0

run_scenario() {
  local name="$1" expected="$2"
  shift 2
  local files=("$@")

  git checkout -q -b "scenario-$name" "$BASE_SHA"
  local f
  for f in "${files[@]}"; do
    mkdir -p "$(dirname "$f")"
    echo "content" > "$f"
  done
  git add -A
  git commit -q -m "scenario $name"
  local head_sha
  head_sha="$(git rev-parse HEAD)"

  local out_file
  out_file="$(mktemp)"
  GITHUB_OUTPUT="$out_file" bash "$CLASSIFY" "$BASE_SHA" "$head_sha" > /dev/null
  local actual
  actual="$(grep '^run_full_ci=' "$out_file" | cut -d= -f2)"
  rm -f "$out_file"
  git checkout -q "$BASE_SHA"
  git branch -q -D "scenario-$name"

  if [ "$actual" != "$expected" ]; then
    echo "FAIL scenario $name: expected run_full_ci=$expected, got run_full_ci=${actual:-<empty>}"
    status=1
  else
    echo "PASS scenario $name: run_full_ci=$actual"
  fi
}

# A - docs only
run_scenario "A-docs-only" false \
  README.md docs/guides/angular.md docs/assets/guides/angular/01-before-you-start.png .github/FUNDING.yml

# B - code only
run_scenario "B-code-only" true \
  src/index.ts

# C - mixed docs + code
run_scenario "C-mixed-docs-and-code" true \
  README.md src/index.ts

# D - package metadata
run_scenario "D-package-metadata" true \
  package.json

# E - workflow itself
run_scenario "E-workflow" true \
  .github/workflows/ci.yml

# F - unknown future path
run_scenario "F-unknown-future-path" true \
  new-runtime/config.toml

# G - documentation tooling under docs/**
run_scenario "G-docs-tooling" false \
  docs/recordings/render-screenshots.mjs

# H - docs + unknown
run_scenario "H-docs-plus-unknown" true \
  docs/guides/python.md some-new-directory/file.xyz

if [ "$status" -ne 0 ]; then
  echo
  echo "classify-ci-changes.sh self-test FAILED"
  exit 1
fi

echo
echo "classify-ci-changes.sh self-test: all scenarios passed"
