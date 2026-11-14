#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 2 ]] || die 'usage: install-release.sh SHA BUNDLE_DIR'
sha="$1"
source_dir="$(realpath "$2")"
require_sha "$sha"
assert_release "$source_dir/api" "$sha" "$source_dir"
assert_release "$source_dir/frontend" "$sha" "$source_dir"

api="$(assert_safe_path "$DX_ROOT/releases/$sha")"
web="$(assert_safe_path "$DX_ROOT/frontend/releases/$sha")"
acquire_lock "$DX_ROOT/locks/release.lock"
python3 "$(dirname "$0")/release-capacity.py" install "$source_dir" "$DX_ROOT" "$sha"

install_tmp=
cleanup_install_tmp() {
  if [[ -n "$install_tmp" ]]; then rm -rf -- "$install_tmp"; fi
}
trap cleanup_install_tmp EXIT

install_one() {
  local src="$1" dst="$2" tmp
  if [[ -d "$dst" ]]; then
    diff -qr --no-dereference "$src" "$dst" >/dev/null || die 'existing release differs'
    return
  fi
  tmp="${dst}.tmp.$$"
  [[ ! -e "$tmp" && ! -L "$tmp" ]] || die 'install staging already exists'
  mkdir "$tmp"
  install_tmp="$tmp"
  cp -a "$src/." "$tmp/"
  mv "$tmp" "$dst"
  install_tmp=
}

install_one "$source_dir/api" "$api"
install_one "$source_dir/frontend" "$web"
ensure_generation "$sha" >/dev/null
ensure_active_aliases
safe_log pass "installed immutable release generation $sha"
