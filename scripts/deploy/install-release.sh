#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"
[[ $# == 2 ]] || die 'usage: install-release.sh SHA BUILD_DIR'; sha="$1"; source_dir="$2"; require_sha "$sha"; assert_release "$source_dir" "$sha"
api="$(assert_safe_path "$DX_ROOT/releases/$sha")"; web="$(assert_safe_path "$DX_ROOT/frontend/releases/$sha")"; acquire_lock "$DX_ROOT/locks/release.lock"
install_one(){ local src="$1" dst="$2"; if [[ -d "$dst" ]]; then diff -qr --no-dereference "$src" "$dst" >/dev/null || die 'existing release differs'; return; fi; local tmp="${dst}.tmp.$$"; mkdir -p "$tmp"; cp -a "$src/." "$tmp/"; mv "$tmp" "$dst"; }
install_one "$source_dir" "$api"
if [[ -d "$web" ]]; then
  assert_release "$web" "$sha"
else
  tmp="${web}.tmp.$$"; mkdir -p "$tmp"; cp -a "$source_dir/frontend/." "$tmp/"; cp "$source_dir/release-manifest.json" "$tmp/release-manifest.json"
  (cd "$tmp" && find . -type f ! -name SHA256SUMS -print0 | LC_ALL=C sort -z | xargs -0 sha256sum > SHA256SUMS && sha256sum --check --strict SHA256SUMS >/dev/null)
  mv "$tmp" "$web"
fi
safe_log pass "installed immutable release $sha"
