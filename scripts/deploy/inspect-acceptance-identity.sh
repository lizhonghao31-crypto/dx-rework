#!/usr/bin/env bash
# Called by the installed root controller; emits no credentials or business rows.
set -euo pipefail
[[ "$(id -un)" == dxacceptance && $# == 2 ]]
snapshot="$(realpath "$1")"
tool_root="$(realpath "$2")"
[[ "$snapshot" == /tmp/dx-acceptance-source.* ]]
export DX_REWORK_ROOT=/opt/dx-rework-acceptance
source "$tool_root/scripts/deploy/lib.sh"
load_app_config
load_database_tool_config
export PGCONNECT_TIMEOUT=10 PGOPTIONS='-c default_transaction_read_only=on'
[[ "$(pg_exec psql "$DATABASE_URL" -XAtqc 'select current_database()')" == dx_rework_acceptance ]]
pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 \
  -c "SELECT json_build_object('database',current_database(),'port',current_setting('port')::integer,'oid',(SELECT oid::bigint FROM pg_database WHERE datname=current_database()),'address',inet_server_addr())" \
  > "$snapshot/acceptance-identity.json"
