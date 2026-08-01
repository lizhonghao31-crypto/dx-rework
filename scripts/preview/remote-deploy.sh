#!/usr/bin/env bash
set -euo pipefail

die() { echo "$1" >&2; exit "${2:-64}"; }

readonly mode="${1:-}"
readonly pr_number="${2:-}"
readonly head_sha="${3:-}"
readonly run_id="${4:-}"
readonly supplied_stage="${5:-}"
[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || die "invalid PR number"
[[ "$head_sha" =~ ^[0-9a-f]{40}$ ]] || die "invalid Head SHA"
[[ "$run_id" =~ ^[1-9][0-9]*$ ]] || die "invalid run ID"

preview_root=/opt/dx-rework/previews
if [[ "${DX_PREVIEW_TEST_MODE:-}" == "1" ]]; then
  preview_root="${DX_PREVIEW_TEST_ROOT:-}"
  [[ "$preview_root" =~ ^/tmp/dx-rework-preview-test-[A-Za-z0-9._-]+$ ]] || die "invalid test preview root"
fi
readonly preview_root
readonly stage_root="$preview_root/.staging"
readonly lock_root="$preview_root/.locks"
readonly rollback_root="$preview_root/.rollback"
readonly target="$preview_root/pr-$pr_number"

assert_real_dir() {
  local directory="$1" resolved
  [[ -d "$directory" && ! -L "$directory" ]] || die "directory unavailable or symlink: $directory" 66
  resolved="$(realpath -e -- "$directory")"
  [[ "$resolved" == "$directory" ]] || die "directory escaped preview root: $directory" 66
}

ensure_control_dir() {
  local directory="$1"
  if [[ -e "$directory" || -L "$directory" ]]; then assert_real_dir "$directory"; else mkdir -m 0700 -- "$directory"; fi
  assert_real_dir "$directory"
}

assert_stage() {
  local directory="$1" resolved base
  [[ -n "$directory" && "$directory" == "$stage_root/"* ]] || die "unsafe staging path" 65
  base="${directory##*/}"
  [[ "$base" =~ ^pr-${pr_number}-${head_sha}-${run_id}\.[A-Za-z0-9]+$ ]] || die "invalid staging name" 65
  [[ -d "$directory" && ! -L "$directory" ]] || die "staging directory unavailable or symlink" 66
  resolved="$(realpath -e -- "$directory")"
  [[ "$resolved" == "$directory" && "$resolved" == "$stage_root/"* ]] || die "staging directory escaped preview root" 66
}

assert_no_symlinks() {
  local directory="$1"
  if find "$directory" -type l -print -quit | grep -q .; then die "symlinks are forbidden in preview artifact" 66; fi
}

safe_remove_stage() {
  local directory="$1"
  assert_stage "$directory"
  rm -rf -- "$directory"
}

assert_real_dir "$preview_root"
ensure_control_dir "$stage_root"
ensure_control_dir "$lock_root"
ensure_control_dir "$rollback_root"

case "$mode" in
  prepare)
    [[ -z "$supplied_stage" ]] || die "prepare does not accept a staging path"
    stage="$(mktemp -d "$stage_root/pr-${pr_number}-${head_sha}-${run_id}.XXXXXX")"
    assert_stage "$stage"
    printf '%s\n' "$stage"
    ;;
  discard)
    assert_stage "$supplied_stage"
    safe_remove_stage "$supplied_stage"
    ;;
  activate)
    assert_stage "$supplied_stage"
    assert_no_symlinks "$supplied_stage"
    [[ -f "$supplied_stage/preview-manifest.json" && ! -L "$supplied_stage/preview-manifest.json" ]] || die "preview manifest missing or unsafe" 66
    node -e 'const m=require(process.argv[1]); if(m.headSha!==process.argv[2]||m.githubRunId!==process.argv[3])process.exit(1)' \
      "$supplied_stage/preview-manifest.json" "$head_sha" "$run_id" || die "preview manifest does not match activation" 67
    printf '%s %s\n' "$run_id" "$head_sha" > "$supplied_stage/.preview-generation"

    lock_file="$lock_root/pr-${pr_number}.lock"
    [[ ! -L "$lock_file" ]] || die "unsafe lock file" 66
    exec 9>"$lock_file"
    flock -x 9

    if [[ -e "$target" || -L "$target" ]]; then
      assert_real_dir "$target"
      assert_no_symlinks "$target"
      [[ -f "$target/.preview-generation" && ! -L "$target/.preview-generation" ]] || die "existing preview has no trusted generation marker" 68
      read -r current_run current_head < "$target/.preview-generation"
      [[ "$current_run" =~ ^[1-9][0-9]*$ && "$current_head" =~ ^[0-9a-f]{40}$ ]] || die "invalid existing generation marker" 68
      if (( current_run > run_id )); then safe_remove_stage "$supplied_stage"; die "stale run cannot replace newer preview" 75; fi
      if (( current_run == run_id )); then
        [[ "$current_head" == "$head_sha" ]] || die "run ID collision" 68
        safe_remove_stage "$supplied_stage"
        exit 0
      fi
    fi

    backup="$rollback_root/pr-${pr_number}-${run_id}-$$"
    [[ "$backup" =~ ^${rollback_root}/pr-${pr_number}-${run_id}-[1-9][0-9]*$ ]] || die "unsafe rollback path" 65
    restore_on_error() {
      local status=$?
      if (( status != 0 )) && [[ -d "$backup" && ! -e "$target" && ! -L "$target" ]]; then mv -- "$backup" "$target"; fi
      exit "$status"
    }
    trap restore_on_error EXIT
    if [[ -d "$target" ]]; then mv -- "$target" "$backup"; fi
    mv -- "$supplied_stage" "$target"
    assert_real_dir "$target"
    assert_no_symlinks "$target"
    read -r active_run active_head < "$target/.preview-generation"
    [[ "$active_run" == "$run_id" && "$active_head" == "$head_sha" ]] || die "activation verification failed" 69
    if [[ -d "$backup" && ! -L "$backup" ]]; then
      [[ "$(realpath -e -- "$backup")" == "$backup" && "$backup" == "$rollback_root/"* ]] || die "unsafe rollback directory" 65
      rm -rf -- "$backup"
    fi
    trap - EXIT
    ;;
  *) die "usage: remote-deploy.sh <prepare|activate|discard> <pr> <head> <run-id> [stage]" ;;
esac
