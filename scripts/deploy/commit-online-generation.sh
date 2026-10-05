#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 1 ]] || die 'generation commit requires dxrework'
require_sha "$1"
acquire_lock "$DX_ROOT/locks/release.lock"
generation="$(ensure_generation "$1")"
ensure_active_aliases
atomic_link "$generation" "$DX_ROOT/active"
