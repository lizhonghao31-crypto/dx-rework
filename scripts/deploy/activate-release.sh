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
acquire_lock "$DX_ROOT/locks/release.lock"

DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}" node_exec \
  "$api/scripts/deploy/database-state.mjs" verify-current \
  "$api/apps/api/src/platform/migration-manifest.json"

old_api=""
old_web=""
if [[ -L "$DX_ROOT/current" || -L "$DX_ROOT/frontend/current" ]]; then
  [[ -L "$DX_ROOT/current" && -L "$DX_ROOT/frontend/current" ]] ||
    die 'current API/frontend mismatch'
  old_api="$(readlink -f "$DX_ROOT/current" 2>/dev/null || true)"
  old_web="$(readlink -f "$DX_ROOT/frontend/current" 2>/dev/null || true)"
  [[ -d "$old_api" && -d "$old_web" ]] || die 'current API/frontend link is broken'
  old_sha="$(basename "$old_api")"
  [[ "$old_sha" =~ ^[0-9a-f]{40}$ && "$old_sha" == "$(basename "$old_web")" ]] ||
    die 'current API/frontend release identity mismatch'
elif [[ -e "$DX_ROOT/current" || -e "$DX_ROOT/frontend/current" ]]; then
  die 'current API/frontend must be symlinks'
fi

restore_previous="${DX_REWORK_ALLOW_PREVIOUS_RESTORE:-true}"
restore() {
  local rc=$?
  trap - ERR EXIT
  if [[ "$restore_previous" == true ]]; then
    if [[ -n "$old_api" ]]; then
      atomic_link "$old_api" "$DX_ROOT/current"
      atomic_link "$old_web" "$DX_ROOT/frontend/current"
      pm2 startOrReload "$old_api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api || true
    else
      rm -f "$DX_ROOT/current" "$DX_ROOT/frontend/current"
      pm2 stop dx-rework-api || true
    fi
    safe_log fail 'activation restored the previous compatible release'
  else
    # Once migrations have advanced, old code may no longer be compatible.
    # Keep both links on the target release and preserve the failure evidence.
    atomic_link "$api" "$DX_ROOT/current" || true
    atomic_link "$web" "$DX_ROOT/frontend/current" || true
    pm2 startOrReload "$api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api || true
    safe_log fail 'activation failed after schema change; target release retained and manual recovery is required'
  fi
  exit "$rc"
}
trap restore ERR EXIT

# Static release switching does not require an Nginx reload. Validate the
# already-installed independent vhost read-only before changing current links.
sudo -n nginx -t
atomic_link "$api" "$DX_ROOT/current"
atomic_link "$web" "$DX_ROOT/frontend/current"
pm2 startOrReload "$api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api
DX_REWORK_SMOKE_LOCAL=true "$(dirname "$0")/smoke.sh" \
  "$sha" "$(manifest_field "$api/release-manifest.json" schemaVersion)"

trap - ERR EXIT
safe_log pass "activated $sha"
