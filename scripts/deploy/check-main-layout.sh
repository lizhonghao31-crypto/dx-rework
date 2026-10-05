#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 1 ]] || die 'layout preflight requires dxrework and previous sha'
require_sha "$1"
api="$(readlink -f "$DX_ROOT/current")"; web="$(readlink -f "$DX_ROOT/frontend/current")"
[[ "$api" == "$DX_ROOT/source" || "$api" == "$DX_ROOT/releases/$1" ]] || die 'unknown current API layout; service untouched'
[[ "$web" == "$DX_ROOT/frontend/source-releases/$1" || "$web" == "$DX_ROOT/frontend/releases/$1" ]] || die 'frontend/API identities differ; service untouched'
