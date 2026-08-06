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
previous="$(current_generation_sha || true)"

# Install the checksum-bound release before any database change. Installation is
# inactive and idempotent, but guarantees recovery code is present locally.
"$(dirname "$0")/install-release.sh" "$sha" "$bundle"
installed_api="$DX_ROOT/releases/$sha"
installed_manifest="$installed_api/apps/api/src/platform/migration-manifest.json"

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
  DATABASE_URL="$DATABASE_URL" "$(dirname "$0")/apply-migrations-safely.sh" \
    "$installed_api" "$current_before"
  migration_applied=true
fi

if ! DATABASE_URL="$DATABASE_URL" node_exec \
  "$installed_api/scripts/deploy/database-state.mjs" verify-current "$installed_manifest" || \
  ! DATABASE_URL="$DATABASE_URL" node_exec \
  "$installed_api/scripts/deploy/verify-database-readiness.mjs" "$installed_manifest"; then
  if [[ "$migration_applied" == true ]]; then
    enter_release_maintenance
    die 'database advanced but target readiness verification failed; maintenance enabled and manual recovery is required'
  fi
  die 'target database readiness verification failed before activation'
fi

allow_previous_restore=true
[[ "$migration_applied" == true ]] && allow_previous_restore=false

if ! DX_REWORK_ALLOW_PREVIOUS_RESTORE="$allow_previous_restore" \
  "$(dirname "$0")/activate-release.sh" "$sha"; then
  if [[ "$migration_applied" == true ]]; then
    die 'activation failed after migration; target generation retained under maintenance'
  fi
  die 'activation failed; previous compatible generation was restored'
fi

if ! DX_REWORK_SMOKE_LOCAL=false "$(dirname "$0")/smoke.sh" "$sha" "$target_version"; then
  if [[ "$migration_applied" == true ]]; then
    enter_release_maintenance
    die 'external smoke failed after migration; target generation retained under maintenance for manual recovery'
  fi

  if [[ "$previous" =~ ^[0-9a-f]{40}$ ]]; then
    if "$(dirname "$0")/rollback.sh" "$previous"; then
      safe_log fail "external smoke failed; compatible previous generation $previous restored"
      exit 1
    fi
    enter_release_maintenance
    die 'external smoke failed and rollback failed; current state preserved under maintenance'
  fi

  # First deployment with no schema change has no compatible previous release.
  enter_release_maintenance
  rm -f "$DX_ROOT/active"
  pm2 stop dx-rework-api || true
  die 'first-deployment smoke failed; target deactivated and maintenance remains enabled'
fi

safe_log pass "release complete evidence=$evidence"
