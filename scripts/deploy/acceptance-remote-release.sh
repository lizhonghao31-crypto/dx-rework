#!/usr/bin/env bash
set -euo pipefail

DX_ROOT="/opt/dx-rework-acceptance"
export DX_REWORK_ROOT="$DX_ROOT"

mode="${1:-}"
shift || true

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

assert_root_layout() {
  local current_user path mode_bits
  current_user="$(id -un)"
  for path in "$DX_ROOT" "$DX_ROOT/incoming" "$DX_ROOT/shared" "$DX_ROOT/logs" "$DX_ROOT/releases" "$DX_ROOT/frontend" "$DX_ROOT/frontend/releases" "$DX_ROOT/generations" "$DX_ROOT/locks"; do
    [[ -d "$path" && ! -L "$path" ]] || fail "required acceptance directory is missing or unsafe: $path"
    [[ "$(stat -c %U "$path")" == "$current_user" ]] || fail "acceptance directory owner mismatch: $path"
    mode_bits="$(stat -c %a "$path")"
    (( (8#$mode_bits & 0022) == 0 )) || fail "acceptance directory is group/world writable: $path"
  done
}

prepare_incoming() {
  [[ $# == 1 ]] || fail 'usage: acceptance-remote-release.sh prepare INCOMING' 64
  local incoming="$1"
  [[ "$incoming" == "$DX_ROOT/incoming/"* ]] || fail 'incoming path is outside isolated acceptance root' 64
  assert_root_layout
  [[ ! -e "$incoming" && ! -L "$incoming" ]] || fail 'incoming directory already exists'
  mkdir -m 0700 "$incoming"
}

assert_acceptance_runtime_config() {
  [[ "${APP_BASE_PATH:-}" == / ]] || fail 'acceptance app base path must be /'
  [[ "${ACCEPTANCE_LAB_ENABLED:-false}" == true ]] || fail 'acceptance lab must be enabled'
  [[ "${ROOT_DINGTALK_USER_ID:-}" == uat-root ]] || fail 'acceptance root identity must be uat-root'
  [[ "${TODO_RUNTIME_ENABLED:-false}" != true ]] || fail 'acceptance forbids real todo runtime'
  [[ "${TODO_DELIVERY_ENABLED:-false}" != true ]] || fail 'acceptance forbids real todo delivery'
  [[ "${TODO_TIMING_ENABLED:-false}" != true ]] || fail 'acceptance forbids real todo timing'
  for key in OSS_REGION OSS_ENDPOINT OSS_BUCKET OSS_ACCESS_KEY_ID OSS_ACCESS_KEY_SECRET OPENAI_API_KEY; do
    [[ -z "${!key:-}" ]] || fail "acceptance forbids external side effect configuration: $key"
  done
}

assert_acceptance_database() {
  local name
  name="$(pg_exec psql "$DATABASE_URL" -XAtqc 'select current_database()')"
  [[ "$name" =~ (acceptance|uat|test) ]] ||
    fail "connected database is not acceptance/test/uat: $name"
}

apply_release() {
  [[ $# == 4 ]] || fail 'usage: acceptance-remote-release.sh apply INCOMING SHA APPLY_MIGRATIONS RUN_ID' 64
  local incoming="$1" sha="$2" apply_migrations="$3" run_id="$4" bundle actual_sha api target_version target_checksum current_before pending generation

  [[ "$incoming" == "$DX_ROOT/incoming/"* ]] || fail 'incoming path is outside isolated acceptance root' 64
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || fail 'invalid release SHA' 64
  [[ "$apply_migrations" == true || "$apply_migrations" == false ]] || fail 'invalid apply-migrations switch' 64
  [[ "$run_id" =~ ^[0-9]+$ ]] || fail 'invalid GitHub run ID' 64
  assert_root_layout
  [[ -f "$incoming/transfer.tar.gz" && ! -L "$incoming/transfer.tar.gz" ]] || fail 'transfer archive is missing or unsafe'

  python3 - "$incoming/transfer.tar.gz" "$incoming" <<'PY'
import sys
import tarfile

archive, destination = sys.argv[1:]
with tarfile.open(archive, "r:gz") as tar:
    for member in tar.getmembers():
        parts = member.name.split("/")
        if (
            member.name.startswith("/")
            or any(part in ("", ".", "..") for part in parts)
            or not (member.isfile() or member.isdir())
        ):
            raise SystemExit("unsafe tar entry")
    tar.extractall(destination, filter="data")
PY

  bundle="$incoming/$sha"
  [[ -d "$bundle/api" && -d "$bundle/frontend" && -f "$bundle/SHA256SUMS" ]] || fail 'release bundle is incomplete'
  actual_sha="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["gitSha"])' "$bundle/release-manifest.json")"
  [[ "$actual_sha" == "$sha" ]] || fail 'bundle SHA mismatch'
  (cd "$bundle" && sha256sum -c --strict SHA256SUMS)
  (cd "$bundle/api" && sha256sum -c --strict SHA256SUMS)
  (cd "$bundle/frontend" && sha256sum -c --strict SHA256SUMS)

  source "$bundle/api/scripts/deploy/lib.sh"
  load_app_config
  load_database_tool_config
  assert_acceptance_runtime_config
  assert_acceptance_database

  target_version="$(manifest_field "$bundle/api/release-manifest.json" schemaVersion)"
  target_checksum="$(manifest_field "$bundle/api/release-manifest.json" schemaChecksum)"
  DATABASE_URL="$DATABASE_URL" node_exec "$bundle/api/scripts/deploy/database-state.mjs" verify-prefix "$bundle/api/apps/api/src/platform/migration-manifest.json"
  current_before="$(DATABASE_URL="$DATABASE_URL" node_exec "$bundle/api/scripts/deploy/database-state.mjs" print-current)"
  pending="$(node_exec -e '
const current=JSON.parse(process.argv[1]);
process.stdout.write(String(current.version!==process.argv[2]||current.checksum!==process.argv[3]));
' "$current_before" "$target_version" "$target_checksum")"
  if [[ "$pending" == true ]]; then
    [[ "$apply_migrations" == true ]] || fail 'acceptance database has pending migrations; rerun with apply_migrations=true'
    GIT_SHA="$sha" DATABASE_URL="$DATABASE_URL" NODE_ENV=test node_exec "$bundle/api/scripts/migrate.mjs"
  fi

  DATABASE_URL="$DATABASE_URL" node_exec "$bundle/api/scripts/deploy/database-state.mjs" verify-current "$bundle/api/apps/api/src/platform/migration-manifest.json"
  DATABASE_URL="$DATABASE_URL" node_exec "$bundle/api/scripts/deploy/verify-database-readiness.mjs" "$bundle/api/apps/api/src/platform/migration-manifest.json"

  "$bundle/api/scripts/deploy/install-release.sh" "$sha" "$bundle"
  api="$DX_ROOT/releases/$sha"
  generation="$(ensure_generation "$sha")"
  ensure_active_aliases
  atomic_link "$generation" "$DX_ROOT/active"

  pm2 startOrReload "$api/infra/pm2/ecosystem.acceptance.config.cjs" --only dx-rework-acceptance-api --update-env
  ready=false
  for _ in $(seq 1 20); do
    if curl -fsS http://127.0.0.1:3202/health/ready >/dev/null 2>&1; then ready=true; break; fi
    sleep 1
  done
  [[ "$ready" == true ]] || fail 'acceptance API did not become ready on 127.0.0.1:3202'

  version="$(curl -fsS http://127.0.0.1:3202/version)"
  node_exec -e '
const v=JSON.parse(process.argv[1]);
if(v.gitSha!==process.argv[2]||v.schemaVersion!==process.argv[3])process.exit(1);
' "$version" "$sha" "$target_version"

  printf 'ACCEPTANCE_DEPLOY_SUCCESS sha=%s schema=%s run=%s\n' "$sha" "$target_version" "$run_id"
}

case "$mode" in
  prepare) prepare_incoming "$@" ;;
  apply) apply_release "$@" ;;
  *) fail 'usage: acceptance-remote-release.sh prepare|apply ...' 64 ;;
esac
