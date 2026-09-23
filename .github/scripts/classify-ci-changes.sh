#!/usr/bin/env bash
# Decides whether a push/PR needs the full product CI estate (unit matrix +
# Docker integration) or can skip it because every changed path is known to
# be documentation/support-only.
#
# Usage: classify-ci-changes.sh <base-sha> <head-sha>
#
# Requires a git checkout that has both <base-sha> and <head-sha> available
# as objects (e.g. actions/checkout with fetch-depth: 0).
#
# Writes `run_full_ci=true` or `run_full_ci=false` to $GITHUB_OUTPUT (when
# set) and prints a human-readable summary to stdout.
#
# Safety invariant: any uncertainty (missing SHAs, a failed diff, an empty
# diff where a real change is expected, or a path this script does not
# recognize) resolves to run_full_ci=true. This script never fails open.

set -u
set -o pipefail

BASE_SHA="${1:-}"
HEAD_SHA="${2:-}"

fail_safe() {
  echo "Classification: $1"
  echo "Full product CI: yes (fail-safe)"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "run_full_ci=true" >> "$GITHUB_OUTPUT"
  fi
  exit 0
}

if [ -z "$BASE_SHA" ] || [ -z "$HEAD_SHA" ]; then
  fail_safe "missing base or head SHA"
fi

if ! git cat-file -e "${BASE_SHA}^{commit}" 2>/dev/null; then
  fail_safe "base SHA $BASE_SHA is not available in this checkout"
fi
if ! git cat-file -e "${HEAD_SHA}^{commit}" 2>/dev/null; then
  fail_safe "head SHA $HEAD_SHA is not available in this checkout"
fi

# NUL-delimited so paths containing spaces or newlines can't break parsing.
changed_files=()
while IFS= read -r -d '' f; do
  changed_files+=("$f")
done < <(git diff --name-only -z "${BASE_SHA}" "${HEAD_SHA}" -- 2>/dev/null)
diff_status=$?

if [ "$diff_status" -ne 0 ]; then
  fail_safe "git diff failed (exit $diff_status)"
fi

if [ "${#changed_files[@]}" -eq 0 ]; then
  fail_safe "no changed files detected between $BASE_SHA and $HEAD_SHA"
fi

echo "Changed files:"
for f in "${changed_files[@]}"; do
  echo "  $f"
done
echo

# Positive allow-list of documentation/support-only paths. Anything not
# matched here is treated as product-relevant, including paths this list
# has never heard of — new product directories must not silently bypass CI.
is_doc_only_path() {
  case "$1" in
    docs/*) return 0 ;;
    README.md) return 0 ;;
    CONTRIBUTING.md) return 0 ;;
    CHANGELOG.md) return 0 ;;
    SECURITY.md) return 0 ;;
    RELEASING.md) return 0 ;;
    CODE_OF_CONDUCT.md) return 0 ;;
    SUPPORT.md) return 0 ;;
    LICENSE|LICENSE.md) return 0 ;;
    .github/FUNDING.yml) return 0 ;;
    .github/ISSUE_TEMPLATE/*) return 0 ;;
    .github/PULL_REQUEST_TEMPLATE.md) return 0 ;;
    .github/PULL_REQUEST_TEMPLATE/*) return 0 ;;
    *) return 1 ;;
  esac
}

product_paths=()
for f in "${changed_files[@]}"; do
  if ! is_doc_only_path "$f"; then
    product_paths+=("$f")
  fi
done

if [ "${#product_paths[@]}" -gt 0 ]; then
  echo "Product-relevant path(s):"
  for f in "${product_paths[@]}"; do
    echo "  $f"
  done
  echo
  echo "Classification: product change"
  echo "Full product CI: yes"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "run_full_ci=true" >> "$GITHUB_OUTPUT"
  fi
else
  echo "Classification: documentation/support only"
  echo "Full product CI: no"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    echo "run_full_ci=false" >> "$GITHUB_OUTPUT"
  fi
fi
