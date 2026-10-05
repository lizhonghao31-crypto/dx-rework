#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 && $# == 1 ]] || { echo 'Usage (root): dx-rework-update main|acceptance' >&2; exit 64; }
case "$1" in
  main) exec /usr/local/bin/dx-rework-deploy ;;
  acceptance) exec /usr/local/bin/dx-acceptance update ;;
  *) echo 'Unknown update target; use main or acceptance.' >&2; exit 64 ;;
esac
