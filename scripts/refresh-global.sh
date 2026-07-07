#!/usr/bin/env bash
# Refresh the bun-global omegacode CLI from this fork.
#
# The installed CLI (~/.bun/bin/omegacode) is a copied dist snapshot, not a
# symlink — commits to this repo do nothing to live runs until this script
# (or its equivalent) rebuilds and reinstalls. Usage:
#   bash scripts/refresh-global.sh          # full gate: typecheck + test + build + install
#   bash scripts/refresh-global.sh --fast   # skip typecheck/test (only when they just ran green)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

if [[ "${1:-}" != "--fast" ]]; then
  pnpm typecheck
  pnpm test
fi
pnpm build

bun add -g "omegacode@$repo"

installed="$HOME/.bun/install/global/node_modules/omegacode/dist/cli.js"
if ! cmp -s "$repo/dist/cli.js" "$installed"; then
  echo "error: installed dist does not match $repo/dist/cli.js — bun install did not refresh the snapshot" >&2
  exit 1
fi

dirty=""
git -C "$repo" diff --quiet HEAD -- src/ package.json 2>/dev/null || dirty=" (dirty working tree)"
echo "ok: global omegacode refreshed to $(git -C "$repo" rev-parse --short HEAD)$dirty"
