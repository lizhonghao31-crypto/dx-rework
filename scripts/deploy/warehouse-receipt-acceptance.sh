#!/usr/bin/env bash
# The installed dx-acceptance holds the production/update/release locks.
set -euo pipefail
[[ "$(id -un)" == dxacceptance && $# == 4 && "${DX_REWORK_LOCK_FD:-}" == 9 ]]
tool_root="$1"
action="$2"
sha="$3"
operator="$4"
[[ "$action" =~ ^(status|activate|safe-read)$ && "$sha" =~ ^[a-f0-9]{40}$ ]]
export DX_REWORK_ROOT=/opt/dx-rework-acceptance
source "$tool_root/scripts/deploy/lib.sh"
acquire_lock "$DX_ROOT/locks/release.lock"
assert_active_release "$sha"
load_app_config
load_database_tool_config
[[ "${APP_BASE_PATH:-}" == /acceptance/ && "${ROOT_DINGTALK_USER_ID:-}" == uat-root && "${ACCEPTANCE_LAB_ENABLED:-}" == true ]] || die 'Acceptance isolation identity mismatch'
for key in TODO_RUNTIME_ENABLED TODO_DELIVERY_ENABLED TODO_TIMING_ENABLED; do [[ "${!key:-false}" != true ]] || die "External side effect enabled: $key"; done
for key in OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OPENAI_API_KEY; do [[ -z "${!key:-}" ]] || die "External credential forbidden in Acceptance: $key"; done
curl -fsS --max-time 10 http://127.0.0.1:3202/health/ready >/dev/null
version="$(curl -fsS --max-time 10 http://127.0.0.1:3202/version)"
node_exec -e 'const v=JSON.parse(process.argv[1]),m=require(process.argv[2]);if(v.gitSha!==process.argv[3]||v.gitSha!==m.gitSha||v.schemaVersion!==m.schemaVersion)process.exit(1)' "$version" "$DX_ROOT/current/release-manifest.json" "$sha"
node_exec "$tool_root/scripts/deploy/warehouse-receipt-acceptance.mjs" "$DX_ROOT/current" "$action" "$sha" "$operator"
