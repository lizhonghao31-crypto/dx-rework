#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"
[[ $# == 1 ]] || die 'usage: rollback.sh TARGET_SHA'; sha="$1"; require_sha "$sha"; api="$DX_ROOT/releases/$sha"; web="$DX_ROOT/frontend/releases/$sha"; assert_release "$api" "$sha"; assert_release "$web" "$sha"; acquire_lock "$DX_ROOT/locks/release.lock"
DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}" node "$api/scripts/deploy/database-state.mjs" verify-current "$api/apps/api/src/platform/migration-manifest.json"
before="$(readlink -f "$DX_ROOT/current" 2>/dev/null||true)"; "$(dirname "$0")/activate-release.sh" "$sha"; "$(dirname "$0")/smoke.sh" "$sha" "$(manifest_field "$api/release-manifest.json" schemaVersion)" || die 'rollback smoke failed'; safe_log pass "rollback before=$before after=$sha"
