#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
release="$(cd "$(dirname "$0")/../.." && pwd -P)"
if [[ "${DX_REWORK_TEST_MODE:-false}" == true ]]; then
  load_env_file "${DX_REWORK_TEST_ENV_FILE:?test env required}" "$(id -un)" "$DX_REWORK_APP_ENV_KEYS"
  node_bin="${DX_REWORK_TEST_NODE:?test node required}"
else
  load_shared_config; node_bin="${DX_REWORK_NODE_BIN:?DX_REWORK_NODE_BIN required in deploy.env}"
fi
readarray -t identity < <(node -e 'const m=require(process.argv[1]); for(const k of ["gitSha","buildTime"]) {if(!m[k])process.exit(2);console.log(m[k])}' "$release/release-manifest.json")
export NODE_ENV=production HOST=127.0.0.1 PORT="${DX_REWORK_TEST_PORT:-3201}" SERVICE_NAME=dx-rework-api GIT_SHA="${identity[0]}" BUILD_TIME="${identity[1]}"
[[ "$node_bin" == /* && -f "$node_bin" && ! -L "$node_bin" && -x "$node_bin" ]] || die 'approved Node executable unavailable or unsafe'
cd "$release"; exec "$node_bin" apps/api/dist/server.js
