#!/usr/bin/env bash
set -euo pipefail

export DX_REWORK_ROOT="${DX_REWORK_ROOT:-/opt/dx-rework-acceptance}"
[[ "$DX_REWORK_ROOT" == /opt/dx-rework-acceptance ]] || {
  echo "acceptance fixture seeding requires the isolated acceptance root" >&2
  exit 64
}

source "$DX_REWORK_ROOT/current/scripts/deploy/lib.sh"
load_app_config
load_database_tool_config

[[ "${ACCEPTANCE_LAB_ENABLED:-false}" == true ]] ||
  die 'acceptance fixture seeding requires ACCEPTANCE_LAB_ENABLED=true'
[[ "${ROOT_DINGTALK_USER_ID:-}" == uat-root ]] ||
  die 'acceptance fixture seeding requires uat-root'
[[ "${TODO_RUNTIME_ENABLED:-false}" != true ]] ||
  die 'acceptance fixture seeding forbids real todo runtime'
[[ "${TODO_DELIVERY_ENABLED:-false}" != true ]] ||
  die 'acceptance fixture seeding forbids real todo delivery'
[[ "${TODO_TIMING_ENABLED:-false}" != true ]] ||
  die 'acceptance fixture seeding forbids real todo timing'

database_name="$(pg_exec psql "$DATABASE_URL" -XAtqc 'select current_database()')"
[[ "$database_name" =~ (^|[_-])(acceptance|accept|uat|test)([_-]|$) ]] ||
  die 'acceptance fixture seeding refused a non-acceptance database'

DATABASE_URL="$DATABASE_URL" DINGTALK_CORP_ID="$DINGTALK_CORP_ID" \
  node_exec "$DX_REWORK_ROOT/current/scripts/deploy/seed-acceptance-role-users.mjs" >/dev/null

root_id="$(pg_exec psql "$DATABASE_URL" -XAtqc "
  SELECT identity.user_id
  FROM identity_mappings identity
  JOIN app_users app_user ON app_user.id=identity.user_id
  WHERE identity.provider='dingtalk'
    AND identity.provider_user_id='uat-root'
    AND identity.union_id='uat-union-root'
    AND identity.active=true
    AND identity.employed=true
    AND app_user.enabled=true
  LIMIT 1
")"
[[ "$root_id" =~ ^[0-9a-fA-F-]{36}$ ]] || die 'acceptance uat-root identity is unavailable'

fixture_ids=(
  "a0000000-0000-4000-8000-000000000001"
  "a0000000-0000-4000-8000-000000000002"
  "a0000000-0000-4000-8000-000000000003"
)

for order_id in "${fixture_ids[@]}"; do
  pg_exec psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 \
    -v order_id="$order_id" -v root_id="$root_id" \
    -c "INSERT INTO production_order_roots(production_order_id,workflow_generation,created_by)
        VALUES(:'order_id'::uuid,'digital_production_v1',:'root_id'::uuid)
        ON CONFLICT(production_order_id) DO NOTHING" >/dev/null
done

node_exec -e '
const ids=process.argv.slice(1);
process.stdout.write(JSON.stringify({
  fixtureKind:"digital-production-root",
  fixtureVersion:1,
  productionOrderIds:ids,
}));
' "${fixture_ids[@]}"
