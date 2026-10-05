#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && $# == 2 ]] || die 'maintenance operation requires dxrework'
action="$1"; sha="$2"
require_sha "$sha"
kernel="$(cd "$(dirname "$0")/../.." && pwd -P)"
api="$DX_ROOT/releases/$sha"
assert_release "$api" "$sha"
load_app_config
load_node_config
case "$action" in
  verify) DATABASE_URL="$DATABASE_URL" node_exec "$kernel/scripts/deploy/database-state.mjs" verify-current "$api/apps/api/src/platform/migration-manifest.json" ;;
  apply)
    DATABASE_URL="$DATABASE_URL" node_exec "$kernel/scripts/deploy/check-main-maintenance-plan.mjs" "$api"
    export DX_REWORK_MIGRATIONS_DIR="$api/apps/api/migrations" DX_REWORK_MIGRATION_MANIFEST="$api/apps/api/src/platform/migration-manifest.json"
    timeout 90 "$(approved_node_bin)" "$kernel/scripts/migrate.mjs"
    ;;
  *) die 'unknown maintenance operation' ;;
esac
