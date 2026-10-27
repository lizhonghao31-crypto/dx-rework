#!/usr/bin/env bash
# Called by the installed root controller; emits no credentials or business rows.
set -euo pipefail
[[ "$(id -un)" == dxacceptance && ( $# == 2 || $# == 3 ) ]]
snapshot="$(realpath "$1")"
tool_root="$(realpath "$2")"
[[ "$snapshot" == /tmp/dx-acceptance-source.* ]]
export DX_REWORK_ROOT=/opt/dx-rework-acceptance
source "$tool_root/scripts/deploy/lib.sh"
load_app_config
load_database_tool_config
[[ "${APP_BASE_PATH:-}" == /acceptance/ && "${ROOT_DINGTALK_USER_ID:-}" == uat-root && "${ACCEPTANCE_LAB_ENABLED:-}" == true && "${DIGITAL_PRODUCTION_ENABLED:-}" == true && "${DIGITAL_PRODUCTION_CREATION_ENABLED:-}" == true ]] || die 'Acceptance identity/configuration mismatch'
for key in TODO_RUNTIME_ENABLED TODO_DELIVERY_ENABLED TODO_TIMING_ENABLED; do [[ "${!key:-false}" != true ]] || die "External side effect enabled: $key"; done
for key in OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OPENAI_API_KEY; do [[ -z "${!key:-}" ]] || die "External credential forbidden in Acceptance: $key"; done
output="$snapshot/acceptance-identity.json"
if [[ $# == 3 ]]; then
  [[ "$3" =~ ^[a-z-]+$ ]]
  output="$snapshot/.acceptance-preflight/identity-$3.json"
fi
export PGCONNECT_TIMEOUT=10 PGOPTIONS='-c default_transaction_read_only=on'
[[ "$(pg_exec psql "$DATABASE_URL" -XAtqc 'select current_database()')" == dx_rework_acceptance ]]
pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 \
  -c "SELECT json_build_object('database',current_database(),'port',current_setting('port')::integer,'oid',(SELECT oid::bigint FROM pg_database WHERE datname=current_database()),'address',inet_server_addr(),'role',current_user,'sessionRole',session_user)" \
  > "$output"
