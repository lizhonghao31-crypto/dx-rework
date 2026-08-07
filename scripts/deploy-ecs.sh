#!/usr/bin/env bash
set -euo pipefail

DX_ROOT=/opt/dx-rework
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"

if [[ "$(id -un)" != "dxrework" ]]; then
  exec sudo -iu dxrework bash "$SOURCE_ROOT/scripts/deploy-ecs.sh"
fi

cd "$SOURCE_ROOT"
source "$SOURCE_ROOT/scripts/deploy/lib.sh"
load_app_config
load_node_config

export PATH="$(dirname "$DX_REWORK_NODE_BIN"):$PATH"

sha="$(git rev-parse HEAD)"
branch="$(git branch --show-current)"
[[ "$branch" == "main" ]] || die "ECS deploy requires main branch, got: ${branch:-detached}"
[[ -z "$(git status --porcelain)" ]] || die 'ECS deploy requires a clean working tree'

build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
build_root="$DX_ROOT/incoming/ecs-build-$sha-$$"
bundle="$build_root/$sha"
api_release="$DX_ROOT/releases/$sha"
web_release="$DX_ROOT/frontend/releases/$sha"
trap 'rm -rf -- "$build_root"' EXIT

printf '=== dx-rework deploy %s ===\n' "$sha"
printf '1/5 install and build\n'
npm ci
APP_BASE_PATH="$APP_BASE_PATH" VITE_BASE_PATH="$APP_BASE_PATH" npm run build

printf '2/5 package release\n'
mkdir -p "$build_root"
rmdir "$build_root"
APP_BASE_PATH="$APP_BASE_PATH" \
VITE_BASE_PATH="$APP_BASE_PATH" \
DX_REWORK_BUILD_ROOT="$DX_ROOT/incoming" \
  "$SOURCE_ROOT/scripts/deploy/package-release.sh" "$sha" "$build_time" "$bundle"

printf '3/5 apply pending migrations\n'
current="$(DATABASE_URL="$DATABASE_URL" node_exec "$bundle/api/scripts/deploy/database-state.mjs" print-current)"
target_version="$(manifest_field "$bundle/api/release-manifest.json" schemaVersion)"
target_checksum="$(manifest_field "$bundle/api/release-manifest.json" schemaChecksum)"
pending="$(node_exec -e '
const current=JSON.parse(process.argv[1]);
process.stdout.write(String(current.version!==process.argv[2]||current.checksum!==process.argv[3]));
' "$current" "$target_version" "$target_checksum")"

if [[ "$pending" == true ]]; then
  if command -v psql >/dev/null 2>&1 && command -v pg_dump >/dev/null 2>&1 && command -v pg_restore >/dev/null 2>&1; then
    GIT_SHA="$sha" \
    CURRENT_DATABASE_STATE="$current" \
    TARGET_SCHEMA_VERSION="$target_version" \
    TARGET_SCHEMA_CHECKSUM="$target_checksum" \
      "$SOURCE_ROOT/scripts/backup-postgres.sh"
  else
    printf 'NOTICE: PostgreSQL client tools are not installed; migration will rely on its transaction rollback.\n'
  fi
  DATABASE_URL="$DATABASE_URL" "$DX_REWORK_NODE_BIN" "$bundle/api/scripts/migrate.mjs"
else
  printf 'database schema already current: %s\n' "$target_version"
fi

printf '4/5 install and reload\n'
rm -rf "$api_release" "$web_release"
cp -a "$bundle/api" "$api_release"
cp -a "$bundle/frontend" "$web_release"
ln -sfn "$api_release" "$DX_ROOT/current"
ln -sfn "$web_release" "$DX_ROOT/frontend/current"
pm2 startOrReload "$api_release/infra/pm2/ecosystem.config.cjs" --only dx-rework-api
pm2 save >/dev/null
sleep 2

printf '5/5 verify\n'
version="$(curl -fsS http://127.0.0.1:3201/version)"
ready="$(curl -fsS http://127.0.0.1:3201/health/ready)"
node_exec -e '
const [version,ready,sha,schema]=process.argv.slice(1);
const v=JSON.parse(version), r=JSON.parse(ready);
if(v.gitSha!==sha||v.schemaVersion!==schema||r.status!=="ready") process.exit(1);
' "$version" "$ready" "$sha" "$target_version"
printf '%s\n' "$version"
printf '%s\n' "$ready"
printf 'DEPLOY SUCCESS: %s\n' "$sha"
