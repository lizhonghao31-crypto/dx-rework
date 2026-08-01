#!/usr/bin/env bash
set -euo pipefail

die() { echo "$1" >&2; exit "${2:-64}"; }

readonly pr_number="${1:-}"
readonly expected_head="${2:-}"
readonly close_run_id="${3:-}"
[[ "$pr_number" =~ ^[1-9][0-9]*$ ]] || die "invalid PR number"
[[ "$expected_head" =~ ^[0-9a-f]{40}$ ]] || die "invalid expected Head SHA"
[[ "$close_run_id" =~ ^[1-9][0-9]*$ ]] || die "invalid close run ID"

preview_root=/opt/dx-rework/previews
if [[ "${DX_PREVIEW_TEST_MODE:-}" == "1" ]]; then
  preview_root="${DX_PREVIEW_TEST_ROOT:-}"
  [[ "$preview_root" =~ ^/tmp/dx-rework-preview-test-[A-Za-z0-9._-]+$ ]] || die "invalid test preview root"
fi
readonly preview_root
readonly stage_root="$preview_root/.staging"
readonly lock_root="$preview_root/.locks"
readonly target="$preview_root/pr-$pr_number"

assert_real_dir() {
  local directory="$1" resolved
  [[ -d "$directory" && ! -L "$directory" ]] || die "directory unavailable or symlink: $directory" 66
  resolved="$(realpath -e -- "$directory")"
  [[ "$resolved" == "$directory" ]] || die "directory escaped preview root: $directory" 66
}

assert_no_symlinks() {
  local directory="$1"
  if find "$directory" -type l -print -quit | grep -q .; then die "symlinks are forbidden in preview tree" 66; fi
}

assert_real_dir "$preview_root"
if [[ -e "$lock_root" || -L "$lock_root" ]]; then assert_real_dir "$lock_root"; else mkdir -m 0700 -- "$lock_root"; fi
lock_file="$lock_root/pr-${pr_number}.lock"
[[ ! -L "$lock_file" ]] || die "unsafe lock file" 66
exec 9>"$lock_file"
flock -x 9

if [[ -e "$target" || -L "$target" ]]; then
  assert_real_dir "$target"
  assert_no_symlinks "$target"
  [[ "$(realpath -e -- "$target")" == "$target" ]] || die "preview target escaped root" 66
  [[ -f "$target/.preview-generation" && ! -L "$target/.preview-generation" ]] || die "preview generation marker missing" 68
  read -r active_run active_head < "$target/.preview-generation"
  [[ "$active_run" =~ ^[1-9][0-9]*$ && "$active_head" =~ ^[0-9a-f]{40}$ ]] || die "invalid preview generation marker" 68
  [[ "$active_head" == "$expected_head" ]] || die "refusing to clean a different Head" 75
  (( active_run <= close_run_id )) || die "refusing to clean a newer preview generation" 75
  rm -rf -- "$target"
fi

if [[ -e "$stage_root" || -L "$stage_root" ]]; then
  assert_real_dir "$stage_root"
  while IFS= read -r -d '' candidate; do
    [[ ! -L "$candidate" ]] || die "unsafe staging symlink" 66
    assert_real_dir "$candidate"
    base="${candidate##*/}"
    [[ "$base" =~ ^pr-${pr_number}-[0-9a-f]{40}-[1-9][0-9]*\.[A-Za-z0-9]+$ ]] || die "unsafe staging entry" 65
    [[ "$candidate" == "$stage_root/"* ]] || die "staging entry escaped root" 66
    assert_no_symlinks "$candidate"
    rm -rf -- "$candidate"
  done < <(find "$stage_root" -mindepth 1 -maxdepth 1 -name "pr-${pr_number}-*" -print0)
fi
