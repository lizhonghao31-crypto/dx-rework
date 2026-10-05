#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

release="$(cd "$(dirname "$0")/../.." && pwd -P)"

if [[ "${DX_REWORK_TEST_MODE:-false}" == true ]]; then
  load_env_file "${DX_REWORK_TEST_ENV_FILE:?test env required}" "$(id -un)" "$DX_REWORK_APP_ENV_KEYS"
  node_bin="${DX_REWORK_TEST_NODE:?test node required}"
  port="${DX_REWORK_TEST_PORT:-3201}"
else
  load_app_config
  load_node_config
  node_bin="${DX_REWORK_NODE_BIN:?DX_REWORK_NODE_BIN required in deploy.env}"
  port="${DX_REWORK_RELEASE_PORT:-3201}"
  [[ "$port" == 3201 || "$port" == 3203 ]] || die 'invalid release port'
fi

[[ "$node_bin" == /* && -f "$node_bin" && ! -L "$node_bin" && -x "$node_bin" ]] ||
  die 'approved Node executable unavailable or unsafe'

readarray -t identity < <(
  "$node_bin" -e 'const m=require(process.argv[1]); for(const k of ["gitSha","buildTime"]) {if(!m[k])process.exit(2);console.log(m[k])}' "$release/release-manifest.json"
)

# Release identity and listener settings cannot be supplied by shared files.
export NODE_ENV=production
export HOST=127.0.0.1
export PORT="$port"
export SERVICE_NAME=dx-rework-api
export GIT_SHA="${identity[0]}"
export BUILD_TIME="${identity[1]}"
if [[ "${DX_REWORK_TEST_MODE:-false}" != true ]]; then
  export DX_REWORK_BACKGROUND_LOCK="$DX_ROOT/locks/background.lock"
fi
unset DX_REWORK_RELEASE_PORT

# Do not leak deployment, restore, or test controls into the API process.
for key in $DX_REWORK_DEPLOY_ENV_KEYS $DX_REWORK_RESTORE_ENV_KEYS; do
  [[ "$key" == DX_REWORK_NODE_BIN ]] || unset "$key"
done
while IFS='=' read -r key _; do
  [[ "$key" == DX_REWORK_TEST_* ]] && unset "$key"
done < <(env)
unset DX_REWORK_NODE_BIN DX_REWORK_EXPECTED_OWNER DX_REWORK_CONFIG_LOADED DX_REWORK_LOCK_FD

cd "$release"
exec "$node_bin" apps/api/dist/server.js
