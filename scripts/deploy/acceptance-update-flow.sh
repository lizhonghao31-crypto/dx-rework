#!/usr/bin/env bash
# Callbacks execute the existing worker/maintenance implementations. Kept separate
# so failure routing is exercised without touching PM2, PostgreSQL or ECS.
acceptance_update_flow() {
  local rc=0
  worker prepare || rc=$?
  [[ "$rc" == 10 ]] && return 0
  [[ "$rc" == 0 ]] || return "$rc"
  maintenance preflight || return $?
  worker backup || return $?
  worker stop || return $?
  rc=0
  maintenance apply || rc=$?
  if (( rc )); then
    worker recover || worker halt || true
    echo 'Migration failed; old runtime recovery requires unchanged history and a previously verified online release.' >&2
    return "$rc"
  fi
  rc=0
  worker activate || rc=$?
  if (( rc )); then
    worker halt || true
    return "$rc"
  fi
}
