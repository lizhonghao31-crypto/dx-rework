#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"
[[ $# == 1 ]] || die 'usage: activate-release.sh SHA'; sha="$1"; require_sha "$sha"; api="$DX_ROOT/releases/$sha"; web="$DX_ROOT/frontend/releases/$sha"; assert_release "$api" "$sha"; assert_release "$web" "$sha"; acquire_lock "$DX_ROOT/locks/release.lock"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}" node "$api/scripts/deploy/database-state.mjs" verify-current "$api/apps/api/src/platform/migration-manifest.json"
old_api="$(readlink -f "$DX_ROOT/current" 2>/dev/null || true)"; old_web="$(readlink -f "$DX_ROOT/frontend/current" 2>/dev/null || true)"
if [[ -n "$old_api" || -n "$old_web" ]]; then [[ -n "$old_api" && -n "$old_web" && "$(basename "$old_api")" == "$(basename "$old_web")" ]] || die 'current API/frontend mismatch'; fi
restore(){ local rc=$?; trap - ERR EXIT; if [[ -n "$old_api" ]]; then atomic_link "$old_api" "$DX_ROOT/current"; atomic_link "$old_web" "$DX_ROOT/frontend/current"; pm2 startOrReload "$old_api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api || true; else rm -f "$DX_ROOT/current" "$DX_ROOT/frontend/current"; pm2 stop dx-rework-api || true; fi; sudo -n nginx -s reload || true; safe_log fail 'activation restored previous current links'; exit "$rc"; }
trap restore ERR EXIT
atomic_link "$api" "$DX_ROOT/current"; atomic_link "$web" "$DX_ROOT/frontend/current"
pm2 startOrReload "$api/infra/pm2/ecosystem.config.cjs" --only dx-rework-api
sudo -n nginx -t; sudo -n nginx -s reload
DX_REWORK_SMOKE_LOCAL=true "$(dirname "$0")/smoke.sh" "$sha" "$(manifest_field "$api/release-manifest.json" schemaVersion)"
trap - ERR EXIT; safe_log pass "activated $sha"
