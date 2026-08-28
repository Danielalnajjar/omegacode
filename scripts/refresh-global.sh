#!/usr/bin/env bash
# Refresh the bun-global omegacode CLI from a verified packed tarball.
#
# The checkout is never installed directly. The script first proves a tarball
# under an isolated BUN_INSTALL prefix, then snapshots the active package/bin
# and Bun global metadata so any failed cutover restores the previous install.
# Usage:
#   bash scripts/refresh-global.sh          # full gate: typecheck + test + build + install
#   bash scripts/refresh-global.sh --fast   # skip typecheck/test (only when they just ran green)
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"
cd "$repo"

prebuilt_tarball="${OMEGACODE_REFRESH_TARBALL:-}"
if [[ -z "$prebuilt_tarball" ]]; then
  if [[ "${1:-}" != "--fast" ]]; then
    pnpm typecheck
    pnpm test
  fi
  pnpm build
else
  [[ "$prebuilt_tarball" = /* && -f "$prebuilt_tarball" ]] || {
    echo "error: OMEGACODE_REFRESH_TARBALL must name an absolute existing tarball" >&2
    exit 1
  }
fi

tmp="$(mktemp -d "${TMPDIR:-/tmp}/omegacode-refresh.XXXXXX")"
active_prefix="${BUN_INSTALL:-$HOME/.bun}"
backup="$tmp/backup"
presence="$backup/.present"
global_state_backup="$backup/global-project"
committed=0
cutover_started=0
lock_acquired=0
lock_dir="$active_prefix/install/global/.omegacode-refresh.lock"
tracked=(
  "install/global/package.json"
  "install/global/bun.lock"
  "install/global/.omegacode-packages"
)

was_present() {
  grep -Fqx -- "$1" "$presence"
}

snapshot_active() {
  mkdir -p "$backup"
  node scripts/global-project-rollback.mjs snapshot "$active_prefix" "$isolated" "$global_state_backup"
  : > "$presence"
  for rel in "${tracked[@]}"; do
    if [[ ! -e "$active_prefix/$rel" && ! -L "$active_prefix/$rel" ]]; then
      continue
    fi
    printf '%s\n' "$rel" >> "$presence"
    mkdir -p "$backup/$(dirname "$rel")"
    cp -a "$active_prefix/$rel" "$backup/$(dirname "$rel")/"
  done
}

restore_snapshot() {
  stage="$1"
  for rel in "${tracked[@]}"; do
    if ! rm -rf "$active_prefix/$rel"; then
      rollback_failures+=("$stage remove $rel")
      continue
    fi
    if was_present "$rel"; then
      if ! mkdir -p "$(dirname "$active_prefix/$rel")" || ! cp -a "$backup/$rel" "$active_prefix/$rel"; then
        rollback_failures+=("$stage restore $rel")
      fi
    fi
  done
}

path_mode() {
  stat -f '%Lp' "$1" 2>/dev/null || stat -c '%a' "$1"
}

verify_restored_path() {
  rel="$1"
  expected="$backup/$rel"
  actual="$active_prefix/$rel"
  if ! was_present "$rel"; then
    [[ ! -e "$actual" && ! -L "$actual" ]]
    return
  fi
  [[ -e "$actual" || -L "$actual" ]] || return 1
  if [[ -L "$expected" ]]; then
    [[ -L "$actual" && "$(readlink "$expected")" == "$(readlink "$actual")" ]]
  elif [[ -f "$expected" ]]; then
    [[ -f "$actual" && ! -L "$actual" && "$(path_mode "$expected")" == "$(path_mode "$actual")" ]] && cmp -s "$expected" "$actual"
  elif [[ -d "$expected" ]]; then
    [[ -d "$actual" && ! -L "$actual" && "$(path_mode "$expected")" == "$(path_mode "$actual")" ]] && diff -qr "$expected" "$actual" >/dev/null
  else
    return 1
  fi
}

restore_active() {
  set +e
  rollback_failures=()
  restore_snapshot "initial"
  if [[ ${#rollback_failures[@]} -eq 0 ]] \
    && was_present "install/global/package.json" \
    && was_present "install/global/bun.lock" \
    && ! BUN_INSTALL="$active_prefix" bun install --cwd "$active_prefix/install/global" --frozen-lockfile >/dev/null; then
      rollback_failures+=("reconcile hoisted dependencies")
  fi

  if ! node scripts/global-project-rollback.mjs restore "$active_prefix" "$isolated" "$global_state_backup"; then
    rollback_failures+=("restore global package and bin entries")
  fi

  # Bun may rewrite shared metadata while reconciling the prefix. Reassert the
  # exact project metadata and script-owned stable artifacts captured before
  # cutover.
  restore_snapshot "final"

  if ! node scripts/global-project-rollback.mjs verify "$active_prefix" "$isolated" "$global_state_backup"; then
    rollback_failures+=("verify global package and bin entries")
  fi
  for rel in "install/global/package.json" "install/global/bun.lock" "install/global/.omegacode-packages"; do
    if ! verify_restored_path "$rel"; then
      rollback_failures+=("verify restored $rel")
    fi
  done
  if [[ ${#rollback_failures[@]} -ne 0 ]]; then
    echo "error: active omegacode rollback incomplete:" >&2
    printf '  - %s\n' "${rollback_failures[@]}" >&2
    return 1
  fi
  return 0
}

cleanup() {
  status=$?
  trap - EXIT
  preserve_backup=0
  if [[ $status -ne 0 && $cutover_started -eq 1 && $committed -eq 0 ]]; then
    set +e
    if restore_active; then
      echo "error: active omegacode install restored after failed cutover" >&2
    else
      echo "error: rollback backup preserved at $backup" >&2
      preserve_backup=1
    fi
  fi
  if [[ $lock_acquired -eq 1 ]]; then
    rm -f "$lock_dir/pid"
    rmdir "$lock_dir" 2>/dev/null || true
  fi
  if [[ $preserve_backup -eq 0 ]]; then rm -rf "$tmp"; fi
  exit "$status"
}
trap cleanup EXIT

if [[ -n "$prebuilt_tarball" ]]; then
  tarball="$tmp/prebuilt.tgz"
  cp "$prebuilt_tarball" "$tarball"
else
  version="$(node -p 'JSON.parse(require("node:fs").readFileSync("package.json", "utf8")).version')"
  pnpm pack --pack-destination "$tmp" >/dev/null
  tarball="$tmp/omegacode-$version.tgz"
  [[ -f "$tarball" ]] || { echo "error: pnpm did not produce $tarball" >&2; exit 1; }
fi
mkdir -p "$tmp/extracted"
tar -xzf "$tarball" -C "$tmp/extracted"
version="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")).version' "$tmp/extracted/package/package.json")"

isolated="$tmp/bun"
BUN_INSTALL="$isolated" bun add -g "$tarball" >/dev/null
node scripts/verify-packed-install.mjs \
  "$tmp/extracted/package" \
  "$isolated/install/global/node_modules/omegacode" \
  "$isolated/bin/omegacode" \
  "$tmp/isolated-receipt.json" >/dev/null

mkdir -p "$(dirname "$lock_dir")"
if ! mkdir "$lock_dir"; then
  echo "error: another Omega global refresh owns $lock_dir" >&2
  exit 73
fi
lock_acquired=1
printf '%s\n' "$$" > "$lock_dir/pid"
snapshot_active

cutover_started=1
stable_dir="$active_prefix/install/global/.omegacode-packages"
tarball_sha256="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$tarball")"
stable_tarball="$stable_dir/omegacode-$version-$tarball_sha256.tgz"
mkdir -p "$stable_dir"
if [[ -e "$stable_tarball" ]]; then
  cmp -s "$tarball" "$stable_tarball" || { echo "error: immutable Omega tarball digest collision at $stable_tarball" >&2; exit 74; }
else
  staged_tarball="$stable_dir/.omegacode-$version-$tarball_sha256.$$.tmp"
  cp "$tarball" "$staged_tarball"
  staged_sha256="$(node -e 'const { createHash } = require("node:crypto"); const { readFileSync } = require("node:fs"); process.stdout.write(createHash("sha256").update(readFileSync(process.argv[1])).digest("hex"))' "$staged_tarball")"
  [[ "$staged_sha256" == "$tarball_sha256" ]] || { echo "error: staged Omega tarball digest changed" >&2; exit 74; }
  mv "$staged_tarball" "$stable_tarball"
fi
BUN_INSTALL="$active_prefix" bun add -g "$stable_tarball" >/dev/null
if [[ "${OMEGACODE_REFRESH_FAIL_AFTER_CUTOVER:-}" == "1" ]]; then
  echo "error: injected post-cutover refresh failure" >&2
  exit 70
fi
node scripts/verify-packed-install.mjs \
  "$tmp/extracted/package" \
  "$active_prefix/install/global/node_modules/omegacode" \
  "$active_prefix/bin/omegacode" >/dev/null
committed=1

dirty=""
git -C "$repo" diff --quiet HEAD -- src/ package.json 2>/dev/null || dirty=" (dirty working tree)"
echo "ok: packed global omegacode refreshed to $(git -C "$repo" rev-parse --short HEAD)$dirty"
