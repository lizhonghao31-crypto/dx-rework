#!/usr/bin/env bash
set -euo pipefail
[[ "$(id -un)" == dxrework ]]
export DX_REWORK_ROOT=/opt/dx-rework
source /opt/dx-rework/current/scripts/deploy/lib.sh
load_env_file "$DX_ROOT/shared/.env" "$(config_owner)" "$DX_REWORK_APP_ENV_KEYS" DATABASE_URL
load_database_tool_config
export PGOPTIONS='-c default_transaction_read_only=on'
pg_exec psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY" -c "SELECT json_build_object('database',current_database(),'migrations',coalesce(json_agg(json_build_object('version',version,'checksum',btrim(checksum)) ORDER BY version),'[]'::json)) FROM schema_migrations" -c COMMIT
