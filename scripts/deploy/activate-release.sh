#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 1 ]] || die 'usage: activate-release.sh SHA'
sha="$1"
require_sha "$sha"
load_release_config

api="$DX_ROOT/releases/$sha"
web="$DX_ROOT/frontend/releases/$sha"
assert_release "$api" "$sha"
assert_release "$web" "$sha"
generation="$(ensure_generation "$sha")"
ensure_active_aliases
acquire_lock "$DX_ROOT/locks/release.lock"

DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}" node_exec \
  "$api/scripts/deploy/database-state.mjs" verify-current \
  "$api/apps/api/src/platform/migration-manifest.json"

old_sha="$(current_generation_sha || true)"
restore_previous="${DX_REWORK_ALLOW_PREVIOUS_RESTORE:-true}"

restore() {
  local rc=$? old_api old_schema
  trap - ERR EXIT INT TERM

  if [[ "$restore_previous" == true ]]; then
    if [[ -n "$old_sha" ]]; then
      old_api="$DX_ROOT/releases/$old_sha"
      old_schema="$(manifest_field "$old_api/release-manifest.json" schemaVersion)"
      atomic_link "$DX_ROOT/generations/$old_sha" "$DX_ROOT/active"
      if pm2 startOrReload "$old_api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api && \
        DX_REWORK_SMOKE_LOCAL=true "$(dirname "$0")/smoke.sh" "$old_sha" "$old_schema"; then
        leave_release_maintenance
        safe_log fail 'activation restored the previous compatible generation'
      else
        safe_log fail 'previous generation restored but readiness failed; maintenance remains enabled'
      fi
    else
      rm -f "$DX_ROOT/active"
      pm2 stop dx-rework-api || true
      leave_release_maintenance
      safe_log fail 'first activation failed; target generation was deactivated'
    fi
  else
    # Once migrations have advanced, old code may no longer be compatible.
    # Keep the target generation selected and leave the maintenance gate in
    # place until a forward-fix or approved database recovery is complete.
    atomic_link "$generation" "$DX_ROOT/active" || true
    pm2 startOrReload "$api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api || true
    safe_log fail 'activation failed after schema change; target generation retained under maintenance'
  fi
  exit "$rc"
}
trap restore ERR EXIT INT TERM

# Nginx reads both stable aliases through the same active generation. A file-
# based maintenance gate blocks external traffic while the pointer and the
# in-memory API process are advanced, without reloading any other vhost.
sudo -n nginx -t
enter_release_maintenance
atomic_link "$generation" "$DX_ROOT/active"
pm2 startOrReload "$api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api
DX_REWORK_SMOKE_LOCAL=true "$(dirname "$0")/smoke.sh" \
  "$sha" "$(manifest_field "$api/release-manifest.json" schemaVersion)"
leave_release_maintenance

trap - ERR EXIT INT TERM
safe_log pass "activated generation $sha"
