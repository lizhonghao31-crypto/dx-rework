#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 2 || ( $# == 3 && "$3" == register-only ) ]] || die 'usage: install-release.sh SHA BUNDLE_DIR [register-only]'
sha="$1"
source_dir="$(realpath "$2")"
require_sha "$sha"
assert_release "$source_dir/api" "$sha" "$source_dir"
assert_release "$source_dir/frontend" "$sha" "$source_dir"

api="$(assert_safe_path "$DX_ROOT/releases/$sha")"
web="$(assert_safe_path "$DX_ROOT/frontend/releases/$sha")"
acquire_lock "$DX_ROOT/locks/release.lock"

python3 "$(dirname "$0")/static-release.py" validate "$source_dir/frontend"

install_one() {
  local src="$1" dst="$2" tmp
  if [[ -d "$dst" ]]; then
    diff -qr --no-dereference "$src" "$dst" >/dev/null || die 'existing release differs'
    if [[ "$dst" == "$web" ]]; then python3 "$(dirname "$0")/static-release.py" normalize "$dst"; fi
    return
  fi
  tmp="${dst}.tmp.$$"
  mkdir -p "$tmp"
  cp -a "$src/." "$tmp/"
  if [[ "$dst" == "$web" ]]; then python3 "$(dirname "$0")/static-release.py" normalize "$tmp"; fi
  mv "$tmp" "$dst"
}

install_one "$source_dir/api" "$api"
install_one "$source_dir/frontend" "$web"
ensure_generation "$sha" >/dev/null
if [[ "${3:-}" != register-only ]]; then ensure_active_aliases; fi
safe_log pass "installed immutable release generation $sha"
