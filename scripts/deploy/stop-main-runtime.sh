#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 2 ]] || die 'stop requires dxrework, sha and port'
require_sha "$1"
[[ "$2" == 3201 || "$2" == 3203 ]] || die 'invalid slot'
name="dx-rework-api-$2"
if ! pm2 describe "$name" >/dev/null 2>&1 && [[ "$2" == 3201 ]]; then name=dx-rework-api; fi
if pm2 describe "$name" >/dev/null 2>&1; then
  pm2 delete "$name"
fi
