#!/usr/bin/env bash
set -euo pipefail

export DX_REWORK_ROOT="${DX_REWORK_ROOT:-/opt/dx-rework-acceptance}"
[[ "$DX_REWORK_ROOT" == /opt/dx-rework-acceptance ]] || {
  echo "acceptance control minting requires the isolated acceptance root" >&2
  exit 64
}

source "$DX_REWORK_ROOT/current/scripts/deploy/lib.sh"
load_app_config
load_node_config

[[ "${ACCEPTANCE_LAB_ENABLED:-false}" == true ]] ||
  die 'acceptance control minting requires ACCEPTANCE_LAB_ENABLED=true'
[[ "${ROOT_DINGTALK_USER_ID:-}" == uat-root ]] ||
  die 'acceptance control minting requires uat-root'
[[ -n "${ACCEPTANCE_LAB_SECRET:-}" ]] ||
  die 'acceptance control minting requires ACCEPTANCE_LAB_SECRET'

cd "$DX_REWORK_ROOT/current"
node_exec --input-type=module -e '
const secret=process.argv[1];
const module=await import("./apps/api/dist/auth/acceptance-control.js");
process.stdout.write(module.mintAcceptanceControlCode(secret));
' "$ACCEPTANCE_LAB_SECRET"
