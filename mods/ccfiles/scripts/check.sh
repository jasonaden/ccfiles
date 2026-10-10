#!/usr/bin/env bash
# CI gate for the ccfiles mod: strict validate, no network APIs, tests.
# Usage: mods/ccfiles/scripts/check.sh
set -euo pipefail
MOD="$(cd "$(dirname "$0")/.." && pwd)"

out="$(claude plugin validate --strict "$MOD")"
echo "$out"

# Observe-only, no network APIs: the calls the loader found must not
# include the network, the model, or MCP.
calls="$(grep -E 'calls:' <<<"$out" || true)"
if grep -Eq '\$\.(http|model|mcp)\b' <<<"$calls"; then
  echo "FAIL: forbidden API in calls: $calls" >&2
  exit 1
fi
echo "no-network check: ok"

# Type check when a TypeScript compiler is at hand (tsc on PATH, or TSC=/path/to/tsc).
TSC="${TSC:-$(command -v tsc || true)}"
if [ -n "$TSC" ]; then
  (cd "$MOD" && "$TSC" -p tsconfig.json --noEmit)
  echo "typecheck: ok"
else
  echo "typecheck: skipped (no tsc; set TSC=/path/to/tsc)"
fi

# Code, README and docs/agents/REQUIREMENTS.md list the same glyph set.
node --experimental-strip-types --no-warnings "$MOD/scripts/check-glyphs.ts"

claude plugin test "$MOD"
