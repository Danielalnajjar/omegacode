#!/bin/sh

# Node 20 has no same-PID exec API. Keep this shell as the SDK's direct child,
# let the Node helper validate and write bounded evidence, then replace the
# shell with the exact executable while retaining the observed PID.

refuse() {
  printf '%s\n' "profile smoke executable wrapper refused its environment" >&2
  exit 78
}

node=${OMEGA_PROFILE_SMOKE_NODE:-}
case ${0##*/} in
  bb)
    helper=${OMEGA_PROFILE_SMOKE_BB_HELPER:-}
    target=${OMEGA_PROFILE_SMOKE_REAL_BB:-}
    ;;
  *)
    helper=${OMEGA_PROFILE_SMOKE_CHILD_HELPER:-}
    target=${OMEGA_PROFILE_SMOKE_REAL_CLAUDE:-}
    ;;
esac

[ -n "$node" ] && [ -n "$helper" ] && [ -n "$target" ] || refuse
[ -x "$node" ] && [ -f "$helper" ] && [ -x "$target" ] || refuse

"$node" "$helper" "$$" "$@" &
helper_pid=$!
terminate() {
  trap - HUP INT TERM
  kill "$helper_pid" 2>/dev/null || true
  wait "$helper_pid" 2>/dev/null || true
  exit 78
}
trap terminate HUP INT TERM
wait "$helper_pid"
status=$?
trap - HUP INT TERM
[ "$status" -eq 0 ] || exit "$status"

exec "$target" "$@"
