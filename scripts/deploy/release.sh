#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/lib.sh"
[[ $# == 2 ]] || die 'usage: release.sh SHA BUNDLE_DIR'; sha="$1"; bundle="$2"; require_sha "$sha"; script_root="$(cd "$(dirname "$0")/../.." && pwd -P)"; acquire_lock "$DX_ROOT/locks/release.lock"
evidence="$(assert_safe_path "${DX_REWORK_EVIDENCE_DIR:-$DX_ROOT/evidence/${GITHUB_RUN_ID:-local}-$sha}")"; mkdir -p "$evidence"; exec > >(tee -a "$evidence/release.jsonl") 2>&1
bundle="$(realpath "$bundle")"; "$(dirname "$0")/preflight.sh" "$sha" "$bundle"; assert_release "$bundle/api" "$sha" "$bundle"; assert_release "$bundle/frontend" "$sha" "$bundle"
[[ "${DX_REWORK_APPLY:-false}" == true ]] || { safe_log pass 'dry-run complete'; exit 0; }
[[ "${DX_REWORK_ENVIRONMENT_APPROVED:-false}" == true && "${DX_REWORK_CONFIRM_RELEASE:-}" == "$sha" ]] || die 'apply approval switches missing'
manifest="$bundle/api/apps/api/src/platform/migration-manifest.json"; node "$bundle/api/scripts/deploy/database-state.mjs" verify-prefix "$manifest"
GIT_SHA="$sha" SCHEMA_VERSION="$(manifest_field "$bundle/api/release-manifest.json" schemaVersion)" SCHEMA_CHECKSUM="$(manifest_field "$bundle/api/release-manifest.json" schemaChecksum)" "$script_root/scripts/backup-postgres.sh"
current="$(node "$bundle/api/scripts/deploy/database-state.mjs" print-current)"; expected="$(manifest_field "$bundle/api/release-manifest.json" schemaVersion)"
if ! node -e 'const c=JSON.parse(process.argv[1]);process.exit(c.version===process.argv[2]?0:1)' "$current" "$expected"; then [[ "${DX_REWORK_APPLY_MIGRATIONS:-false}" == true ]] || die 'pending migrations require DX_REWORK_APPLY_MIGRATIONS=true'; (cd "$script_root" && node scripts/migrate.mjs); fi
node "$bundle/api/scripts/deploy/database-state.mjs" verify-current "$manifest"; "$(dirname "$0")/install-release.sh" "$sha" "$bundle"
previous="$(basename "$(readlink -f "$DX_ROOT/current" 2>/dev/null||true)")"; "$(dirname "$0")/activate-release.sh" "$sha"
if ! "$(dirname "$0")/smoke.sh" "$sha" "$expected"; then [[ "$previous" =~ ^[0-9a-f]{40}$ ]] && "$(dirname "$0")/rollback.sh" "$previous" || { rm -f "$DX_ROOT/current" "$DX_ROOT/frontend/current"; pm2 stop dx-rework-api || true; }; die 'smoke failed; rollback completed'; fi
safe_log pass "release complete evidence=$evidence"
