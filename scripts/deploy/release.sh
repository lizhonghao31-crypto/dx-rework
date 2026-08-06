#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ $# == 2 ]] || die 'usage: release.sh SHA BUILD_DIR'
sha="$1"; build="$2"; require_sha "$sha"
evidence="$(assert_safe_path "${DX_REWORK_EVIDENCE_DIR:-$DX_ROOT/evidence/$sha}")"; mkdir -p "$evidence"; dry="${DX_REWORK_APPLY:-false}"
"$(dirname "$0")/preflight.sh" "$sha" "$build" | tee "$evidence/preflight.jsonl"; assert_release "$build" "$sha"
if [[ "$dry" != true ]]; then safe_log pass 'dry-run complete; no backup, migration, install or activation performed' | tee "$evidence/result.jsonl"; exit 0; fi
[[ "${DX_REWORK_ENVIRONMENT_APPROVED:-false}" == true && "${DX_REWORK_CONFIRM_RELEASE:-}" == "$sha" ]] || die 'apply approval switches missing'
GIT_SHA="$sha" SCHEMA_VERSION="$(manifest_field "$build/release-manifest.json" schemaVersion)" scripts/backup-postgres.sh | tee "$evidence/backup.jsonl"
npm run db:migrate:lint; if [[ "${DX_REWORK_APPLY_MIGRATIONS:-false}" == true ]]; then npm run db:migrate; fi
scripts/deploy/install-release.sh "$sha" "$build"; previous="$(basename "$(readlink -f "$DX_ROOT/current" 2>/dev/null||true)")"; scripts/deploy/activate-release.sh "$sha"; if ! scripts/deploy/smoke.sh "$sha" "$(manifest_field "$build/release-manifest.json" schemaVersion)"; then [[ "$previous" =~ ^[0-9a-f]{40}$ ]] && scripts/deploy/rollback.sh "$previous"; die 'smoke failed; controlled rollback attempted'; fi; safe_log pass "release complete evidence=$evidence"
