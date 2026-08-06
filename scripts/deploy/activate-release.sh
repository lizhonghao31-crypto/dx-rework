#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"
[[ $# == 1 ]] || die 'usage: activate-release.sh SHA'; sha="$1"; require_sha "$sha"; api="$DX_ROOT/releases/$sha"; web="$DX_ROOT/frontend/releases/$sha"; assert_release "$api" "$sha"; assert_release "$web" "$sha"; acquire_lock "$DX_ROOT/locks/release.lock"
[[ "${DX_REWORK_MIGRATION_HISTORY_OK:-false}" == true ]] || die 'migration history not verified'; nginx -t; grep -q 'cwd: "/opt/dx-rework/current"' infra/pm2/ecosystem.config.cjs || die 'PM2 cwd mismatch'
printf '%s\n' "$(readlink "$DX_ROOT/current" 2>/dev/null||true)" > "$DX_ROOT/logs/previous-api"; atomic_link "$api" "$DX_ROOT/current"; atomic_link "$web" "$DX_ROOT/frontend/current"; [[ "$(basename "$(readlink -f "$DX_ROOT/current")")" == "$sha" && "$(basename "$(readlink -f "$DX_ROOT/frontend/current")")" == "$sha" ]] || die 'atomic activation mismatch'
pm2 startOrReload infra/pm2/ecosystem.config.cjs --only dx-rework-api; nginx -s reload; safe_log pass "activated $sha"
