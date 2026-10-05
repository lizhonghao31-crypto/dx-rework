#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 2 ]] || die 'backup requires dxrework and frozen candidate/previous sha'
require_sha "$1"; require_sha "$2"
kernel="$(cd "$(dirname "$0")/../.." && pwd -P)"
load_app_config
load_database_tool_config
old="$DX_ROOT/releases/$2"; candidate="$DX_ROOT/releases/$1"
DATABASE_URL="$DATABASE_URL" node_exec "$kernel/scripts/deploy/database-state.mjs" verify-current "$old/apps/api/src/platform/migration-manifest.json" >/dev/null
current="$(DATABASE_URL="$DATABASE_URL" node_exec "$kernel/scripts/deploy/database-state.mjs" print-current)"
bytes="$(pg_exec psql "$DATABASE_URL" -XAtqc 'select pg_database_size(current_database())')"
free="$(df -Pk "$DX_ROOT" | awk 'NR==2 {print $4}')"
[[ "$bytes" =~ ^[0-9]+$ && "$free" =~ ^[0-9]+$ ]]
(( free * 1024 >= bytes * 3 && free * 1024 >= 268435456 )) || die 'insufficient backup/migration disk headroom'
export GIT_SHA="$1" CURRENT_DATABASE_STATE="$current"
export TARGET_SCHEMA_VERSION="$(manifest_field "$candidate/release-manifest.json" schemaVersion)"
export TARGET_SCHEMA_CHECKSUM="$(manifest_field "$candidate/release-manifest.json" schemaChecksum)"
export PGCONNECT_TIMEOUT=10
timeout 180 bash "$kernel/scripts/backup-postgres.sh"
