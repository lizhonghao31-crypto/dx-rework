#!/usr/bin/env bash
set -euo pipefail

DX_ROOT=/opt/dx-rework
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
EXPECTED_ORIGIN='git@github.com:lizhonghao31-crypto/dx-rework.git'
DEPS_MARKER="$DX_ROOT/shared/build-package-lock.sha256"
WEB_RELEASE_ROOT="$DX_ROOT/frontend/source-releases"

if [[ "$(id -un)" != "dxrework" ]]; then
  exec sudo -iu dxrework bash "$SOURCE_ROOT/scripts/deploy-ecs.sh"
fi

cd "$SOURCE_ROOT"
source "$SOURCE_ROOT/scripts/deploy/lib.sh"
for key in $DX_REWORK_APP_ENV_KEYS; do unset "$key"; done
load_env_file "${DX_REWORK_APP_ENV_FILE:-$DX_ROOT/shared/.env}" "$(config_owner)" "$DX_REWORK_APP_ENV_KEYS" 'APP_BASE_PATH'
load_node_config
export PATH="$(dirname "$DX_REWORK_NODE_BIN"):$PATH"

branch="$(git branch --show-current)"
origin_url="$(git remote get-url origin)"
[[ "$branch" == "main" ]] || die "ECS deploy requires main branch, got: ${branch:-detached}"
[[ "$origin_url" == "$EXPECTED_ORIGIN" ]] || die 'ECS deploy origin does not match the approved dx-rework repository'
[[ -z "$(git status --porcelain)" ]] || die 'ECS deploy requires a clean working tree'
git fetch origin main
sha="$(git rev-parse HEAD)"
remote_sha="$(git rev-parse origin/main)"
[[ "$sha" == "$remote_sha" ]] || die 'ECS deploy requires HEAD to match origin/main'

acquire_lock "$DX_ROOT/locks/release.lock"
build_time="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

repair_links() {
  "$DX_REWORK_NODE_BIN" <<'NODE'
const fs = require('fs');
const path = require('path');
const source = process.cwd();
const root = path.join(source, 'node_modules');
const binDir = path.join(root, '.bin');
const packages = [];
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.name === '.bin') continue;
  const full = path.join(root, entry.name);
  if (entry.name.startsWith('@') && entry.isDirectory()) {
    for (const child of fs.readdirSync(full, { withFileTypes: true })) {
      if (child.isDirectory()) packages.push(path.join(full, child.name));
    }
  } else if (entry.isDirectory()) packages.push(full);
}
fs.rmSync(binDir, { recursive: true, force: true });
fs.mkdirSync(binDir, { recursive: true });
for (const pkgDir of packages) {
  const manifest = path.join(pkgDir, 'package.json');
  if (!fs.existsSync(manifest)) continue;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(manifest, 'utf8')); } catch { continue; }
  if (!pkg.bin) continue;
  const bins = typeof pkg.bin === 'string'
    ? { [String(pkg.name || path.basename(pkgDir)).split('/').pop()]: pkg.bin }
    : pkg.bin;
  for (const [name, rel] of Object.entries(bins || {})) {
    if (typeof rel !== 'string' || !name) continue;
    const target = path.join(pkgDir, rel);
    if (!fs.existsSync(target)) continue;
    const link = path.join(binDir, name);
    fs.rmSync(link, { force: true });
    fs.symlinkSync(path.relative(path.dirname(link), target), link);
  }
}
const workspaces = {
  '@dx-rework/contracts': 'packages/contracts',
  '@dx-rework/config': 'packages/config',
  '@dx-rework/domain': 'packages/domain',
  '@dx-rework/ui': 'packages/ui',
  '@dx-rework/api': 'apps/api',
  '@dx-rework/web': 'apps/web',
};
for (const [name, rel] of Object.entries(workspaces)) {
  const [scope, pkg] = name.split('/');
  const link = path.join(root, scope, pkg);
  const target = path.join(source, rel);
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { recursive: true, force: true });
  fs.symlinkSync(path.relative(path.dirname(link), target), link, 'dir');
}
NODE
}

printf '=== dx-rework fast deploy %s ===\n' "$sha"
printf '1/4 dependencies\n'
lock_hash="$(sha256sum package-lock.json | awk '{print $1}')"
deps_ready=false
if [[ -d node_modules && ! -L node_modules \
      && -x node_modules/.bin/tsc \
      && -x node_modules/.bin/vite \
      && -f "$DEPS_MARKER" \
      && "$(cat "$DEPS_MARKER")" == "$lock_hash" ]]; then
  deps_ready=true
fi

if [[ "$deps_ready" == true ]]; then
  printf 'dependencies unchanged; reuse persistent source node_modules\n'
elif [[ "$(readlink -f "$DX_ROOT/current" 2>/dev/null || true)" != "$SOURCE_ROOT" \
        && -f "$DX_ROOT/current/package-lock.json" \
        && -d "$DX_ROOT/current/node_modules" \
        && ! -L "$DX_ROOT/current/node_modules" ]] \
     && cmp -s package-lock.json "$DX_ROOT/current/package-lock.json"; then
  printf 'bootstrap source build dependencies from local current release\n'
  rm -rf node_modules
  cp -a "$DX_ROOT/current/node_modules" node_modules
  repair_links
  node_modules/.bin/tsc --version >/dev/null
  node_modules/.bin/vite --version >/dev/null
  printf '%s\n' "$lock_hash" > "${DEPS_MARKER}.tmp.$$"
  mv "${DEPS_MARKER}.tmp.$$" "$DEPS_MARKER"
else
  printf 'package-lock changed or build dependencies unavailable; install once\n'
  [[ -L node_modules ]] && rm -f node_modules
  npm install --prefer-offline --no-audit --no-fund --progress=false
  repair_links
  node_modules/.bin/tsc --version >/dev/null
  node_modules/.bin/vite --version >/dev/null
  git diff --quiet -- package.json package-lock.json || die 'dependency install changed package metadata'
  printf '%s\n' "$lock_hash" > "${DEPS_MARKER}.tmp.$$"
  mv "${DEPS_MARKER}.tmp.$$" "$DEPS_MARKER"
fi

printf '2/4 build\n'
APP_BASE_PATH="$APP_BASE_PATH" VITE_BASE_PATH="$APP_BASE_PATH" npm run build

printf '3/4 migrate and switch\n'
load_app_config
DATABASE_URL="$DATABASE_URL" "$DX_REWORK_NODE_BIN" scripts/migrate.mjs
schema_version="$($DX_REWORK_NODE_BIN -e 'const m=require("./apps/api/src/platform/migration-manifest.json");process.stdout.write(m.migrations.at(-1).version)')"
cat > release-manifest.json <<JSON
{"gitSha":"$sha","buildTime":"$build_time","schemaVersion":"$schema_version","appBasePath":"$APP_BASE_PATH","viteBasePath":"$APP_BASE_PATH"}
JSON

web_target="$WEB_RELEASE_ROOT/$sha"
rm -rf "$web_target"
mkdir -p "$web_target"
cp -a apps/web/dist/. "$web_target/"
cat > "$web_target/release-manifest.json" <<JSON
{"gitSha":"$sha","buildTime":"$build_time","schemaVersion":"$schema_version","appBasePath":"$APP_BASE_PATH","viteBasePath":"$APP_BASE_PATH","kind":"frontend"}
JSON
(cd "$web_target" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)
retain_previous_frontend_assets "$sha"
ln -sfn "$SOURCE_ROOT" "$DX_ROOT/current"
ln -sfn "$web_target" "$DX_ROOT/frontend/current"

pm2 startOrReload "$SOURCE_ROOT/infra/pm2/ecosystem.config.cjs" --only dx-rework-api
pm2 save >/dev/null

printf '4/4 verify\n'
ready=false
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS http://127.0.0.1:3201/health/ready >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done
[[ "$ready" == true ]] || die 'API did not become ready'
version="$(curl -fsS http://127.0.0.1:3201/version)"
"$DX_REWORK_NODE_BIN" -e 'const v=JSON.parse(process.argv[1]);if(v.gitSha!==process.argv[2])process.exit(1)' "$version" "$sha"
public_web_base="${TODO_PUBLIC_BASE_URL:-}"
[[ "$public_web_base" == https://* ]] || die 'TODO_PUBLIC_BASE_URL must be configured for deployment smoke'
curl -fsS -o /dev/null "${public_web_base%/}/"
printf '%s\n' "$version"
printf 'DEPLOY SUCCESS: %s\n' "$sha"
