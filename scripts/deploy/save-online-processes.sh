#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -un)" == dxrework && $# == 0 ]] || exit 64
pm2 save >/dev/null
