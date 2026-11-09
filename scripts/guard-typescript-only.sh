#!/usr/bin/env bash
# Enforces the repo's TypeScript-only rule: no hand-written JavaScript source
# may be committed. `dist/` is gitignored build output, so `git ls-files` never
# sees it — anything this finds is real source that should have been .ts/.tsx.
set -euo pipefail

offenders=$(git ls-files '*.js' '*.jsx' '*.mjs' '*.cjs')

if [[ -n "$offenders" ]]; then
  echo "TypeScript-only rule violated — these tracked files must be .ts/.tsx:" >&2
  echo "$offenders" | sed 's/^/  /' >&2
  exit 1
fi

echo "TypeScript-only: OK (no tracked JavaScript source)"
