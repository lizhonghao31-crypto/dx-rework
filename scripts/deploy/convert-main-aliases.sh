#!/usr/bin/env bash
# Called only after nginx has quiesced and the previous API has stopped.
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 1 ]] || die 'alias conversion requires dxrework and frozen previous sha'
require_sha "$1"
acquire_lock "$DX_ROOT/locks/release.lock"
generation="$(ensure_generation "$1")"
api="$(readlink -f "$DX_ROOT/current")"
web="$(readlink -f "$DX_ROOT/frontend/current")"
[[ "$api" == "$DX_ROOT/source" || "$api" == "$DX_ROOT/releases/$1" ]] || die 'unknown previous API layout; aliases retained'
[[ "$web" == "$DX_ROOT/frontend/source-releases/$1" || "$web" == "$DX_ROOT/frontend/releases/$1" ]] || die 'unknown previous frontend layout; aliases retained'
for pair in "current:api" "frontend/current:frontend"; do
  alias="${pair%:*}"; target="${pair#*:}"
  ln -s "$DX_ROOT/active/$target" "$DX_ROOT/$alias.tmp.$$"
  mv -Tf "$DX_ROOT/$alias.tmp.$$" "$DX_ROOT/$alias"
done
atomic_link "$generation" "$DX_ROOT/active"
