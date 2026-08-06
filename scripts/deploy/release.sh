#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 2 ]] || die 'usage: release.sh SHA BUNDLE_DIR'
sha="$1"
bundle="$2"
require_sha "$sha"

script_root="$(cd "$(dirname "$0")/../.." && pwd -P)"
load_release_config
acquire_lock "$DX_ROOT/locks/release.lock"

evidence="$(assert_safe_path "${DX_REWORK_EVIDENCE_DIR:-$DX_ROOT/evidence/${GITHUB_RUN_ID:-local}-$sha}")"
mkdir -p "$evidence"
exec > >(tee -a "$evidence/release.jsonl") 2>&1

bundle="$(realpath "$bundle")"
"$(dirname "$0")/preflight.sh" "$sha" "$bundle"
assert_release "$bundle/api" "$sha" "$bundle"
assert_release "$bundle/frontend" "$sha" "$bundle"

[[ "${DX_REWORK_APPLY:-false}" == true ]] || {
  safe_log pass 'dry-run complete'
  exit 0
}
[[ "${DX_REWORK_ENVIRONMENT_APPROVED:-false}" == true && "${DX_REWORK_CONFIRM_RELEASE:-}" == "$sha" ]] ||
  die 'apply approval switches missing'

manifest="$bundle/api/apps/api/src/platform/migration-manifest.json"
target_version="$(manifest_field "$bundle/api/release-manifest.json" schemaVersion)"
target_checksum="$(manifest_field "$bundle/api/release-manifest.json" schemaChecksum)"

DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}" node_exec \
  "$bundle/api/scripts/deploy/database-state.mjs" verify-prefix "$manifest"
current_before="$(DATABASE_URL="$DATABASE_URL" node_exec "$bundle/api/scripts/deploy/database-state.mjs" print-current)"

# Install the checksum-bound release before any database change. Installation is
# inactive and idempotent, but guarantees recovery code is present locally.
"$(dirname "$0")/install-release.sh" "$sha" "$bundle"

GIT_SHA="$sha" \
TARGET_SCHEMA_VERSION="$target_version" \
TARGET_SCHEMA_CHECKSUM="$target_checksum" \
CURRENT_DATABASE_STATE="$current_before" \
  "$script_root/scripts/backup-postgres.sh"

pending="$(node_exec -e '
const current=JSON.parse(process.argv[1]);
process.stdout.write(String(current.version!==process.argv[2]||current.checksum!==process.argv[3]));
' "$current_before" "$target_version" "$target_checksum")"
migration_applied=false
if [[ "$pending" == true ]]; then
  [[ "${DX_REWORK_APPLY_MIGRATIONS:-false}" == true ]] ||
    die 'pending migrations require DX_REWORK_APPLY_MIGRATIONS=true'
  (cd "$bundle/api" && DATABASE_URL="$DATABASE_URL" node_exec scripts/migrate.mjs)
  migration_applied=true
fi

DATABASE_URL="$DATABASE_URL" node_exec \
  "$bundle/api/scripts/deploy/database-state.mjs" verify-current "$manifest"
DATABASE_URL="$DATABASE_URL" node_exec \
  "$bundle/api/scripts/deploy/verify-database-readiness.mjs" "$manifest"

previous="$(basename "$(readlink -f "$DX_ROOT/current" 2>/dev/null || true)")"
allow_previous_restore=true
[[ "$migration_applied" == true ]] && allow_previous_restore=false

if ! DX_REWORK_ALLOW_PREVIOUS_RESTORE="$allow_previous_restore" \
  "$(dirname "$0")/activate-release.sh" "$sha"; then
  if [[ "$migration_applied" == true ]]; then
    die 'activation failed after migration; target release retained and manual recovery is required'
  fi
  die 'activation failed; previous compatible release was restored'
fi

if ! DX_REWORK_SMOKE_LOCAL=false "$(dirname "$0")/smoke.sh" "$sha" "$target_version"; then
  if [[ "$migration_applied" == true ]]; then
    die 'external smoke failed after migration; target release retained and manual recovery is required'
  fi

  if [[ "$previous" =~ ^[0-9a-f]{40}$ ]]; then
    if "$(dirname "$0")/rollback.sh" "$previous"; then
      safe_log fail "external smoke failed; compatible previous release $previous restored"
      exit 1
    fi
    die 'external smoke failed and rollback failed; current state preserved for manual recovery'
  fi

  # First deployment with no schema change has no compatible previous release.
  rm -f "$DX_ROOT/current" "$DX_ROOT/frontend/current"
  pm2 stop dx-rework-api || true
  die 'first-deployment smoke failed; target deactivated without changing database schema'
fi

safe_log pass "release complete evidence=$evidence"
