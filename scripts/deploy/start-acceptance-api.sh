#!/usr/bin/env bash
set -euo pipefail

export DX_REWORK_ROOT="${DX_REWORK_ROOT:-/opt/dx-rework-acceptance}"
source "$(dirname "$0")/lib.sh"

[[ "$DX_REWORK_ROOT" == /opt/dx-rework-acceptance ]] ||
  die 'acceptance runtime root must be /opt/dx-rework-acceptance'

release="$(cd "$(dirname "$0")/../.." && pwd -P)"
load_app_config
load_node_config

[[ "${ACCEPTANCE_LAB_ENABLED:-false}" == true ]] || die 'acceptance lab must be enabled'
[[ "${ROOT_DINGTALK_USER_ID:-}" == uat-root ]] || die 'acceptance runtime requires uat-root'
[[ "${DIGITAL_PRODUCTION_ENABLED:-false}" == true ]] || die 'acceptance runtime requires digital production'
[[ "${DIGITAL_PRODUCTION_CREATION_ENABLED:-false}" == true ]] || die 'acceptance runtime requires digital production creation'
[[ "${TODO_RUNTIME_ENABLED:-false}" != true ]] || die 'acceptance runtime forbids real todo runtime'
[[ "${TODO_DELIVERY_ENABLED:-false}" != true ]] || die 'acceptance runtime forbids real todo delivery'
[[ "${TODO_TIMING_ENABLED:-false}" != true ]] || die 'acceptance runtime forbids real todo timing'
for key in OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OPENAI_API_KEY; do
  [[ -z "${!key:-}" ]] || die "acceptance runtime forbids external side effect configuration: $key"
done

node_bin="${DX_REWORK_NODE_BIN:?DX_REWORK_NODE_BIN required in deploy.env}"
[[ "$node_bin" == /* && -f "$node_bin" && ! -L "$node_bin" && -x "$node_bin" ]] ||
  die 'approved Node executable unavailable or unsafe'

readarray -t identity < <(
  "$node_bin" -e 'const m=require(process.argv[1]); for(const k of ["gitSha","buildTime"]) {if(!m[k])process.exit(2);console.log(m[k])}' "$release/release-manifest.json"
)

export NODE_ENV=test
export HOST=127.0.0.1
export PORT=3202
export SERVICE_NAME=dx-rework-acceptance-api
export GIT_SHA="${identity[0]}"
export BUILD_TIME="${identity[1]}"

for key in $DX_REWORK_DEPLOY_ENV_KEYS $DX_REWORK_RESTORE_ENV_KEYS; do
  [[ "$key" == DX_REWORK_NODE_BIN ]] || unset "$key"
done
unset DX_REWORK_NODE_BIN DX_REWORK_EXPECTED_OWNER DX_REWORK_CONFIG_LOADED DX_REWORK_LOCK_FD
unset DX_REWORK_ACCEPTANCE_RELEASE_SHA

cd "$release"
exec "$node_bin" apps/api/dist/server.js
