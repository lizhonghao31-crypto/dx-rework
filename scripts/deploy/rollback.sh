#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"

[[ $# == 1 ]] || die 'usage: rollback.sh TARGET_SHA'
sha="$1"
require_sha "$sha"
load_release_config

api="$DX_ROOT/releases/$sha"
web="$DX_ROOT/frontend/releases/$sha"
assert_release "$api" "$sha"
assert_release "$web" "$sha"
ensure_generation "$sha" >/dev/null
ensure_active_aliases
acquire_lock "$DX_ROOT/locks/release.lock"

# A code rollback is permitted only when the live database exactly matches the
# target release migration manifest. Forward-only migrations therefore block
# unsafe rollback automatically.
DATABASE_URL="${DATABASE_URL:?DATABASE_URL required}" node_exec \
  "$api/scripts/deploy/database-state.mjs" verify-current \
  "$api/apps/api/src/platform/migration-manifest.json"

before="$(current_generation_sha || true)"
DX_REWORK_ALLOW_PREVIOUS_RESTORE=true "$(dirname "$0")/activate-release.sh" "$sha"
# activate-release already performs the local API readiness/version smoke.
safe_log pass "rollback before=${before:-none} after=$sha"
