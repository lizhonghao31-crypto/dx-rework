#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ $# == 3 ]] || die 'usage: package-release.sh SHA ISO_BUILD_TIME OUTPUT_DIR'
sha="$1"; build_time="$2"; out="$(assert_safe_path "$3" "${DX_REWORK_BUILD_ROOT:-$PWD/.pr17-build}")"
require_sha "$sha"; date -d "$build_time" -u +%FT%TZ >/dev/null || die 'invalid ISO build time'
[[ ! -e "$out" && ! -L "$out" ]] || die 'output already exists'
for p in apps/api/dist apps/web/dist packages/config/dist packages/contracts/dist packages/domain/dist node_modules package-lock.json; do [[ -e "$p" ]] || die "built input missing: $p"; done
stage="${out}.tmp.$$"; trap 'rm -rf -- "$stage"' EXIT; mkdir -p "$stage/api/apps/api/src" "$stage/api/packages" "$stage/frontend"
cp package.json package-lock.json "$stage/api/"; cp -aL node_modules "$stage/api/"
cp apps/api/package.json "$stage/api/apps/api/"; cp -a apps/api/dist apps/api/migrations "$stage/api/apps/api/"; cp -a apps/api/src/platform "$stage/api/apps/api/src/"
for p in packages/config packages/contracts packages/domain; do mkdir -p "$stage/api/$p"; cp "$p/package.json" "$stage/api/$p/"; cp -a "$p/dist" "$stage/api/$p/"; done
mkdir -p "$stage/api/scripts/deploy" "$stage/api/infra/pm2"; cp scripts/deploy/* "$stage/api/scripts/deploy/"; cp scripts/backup-postgres.sh scripts/restore-postgres.sh scripts/migrate.mjs scripts/migration-lib.mjs "$stage/api/scripts/"; cp infra/pm2/ecosystem.config.cjs "$stage/api/infra/pm2/"
cp -a apps/web/dist/. "$stage/frontend/"
node - "$stage" "$sha" "$build_time" <<'JS'
const fs=require('fs'),cp=require('child_process'),path=require('path'); const [root,gitSha,buildTime]=process.argv.slice(2);
const migrations=JSON.parse(fs.readFileSync('apps/api/src/platform/migration-manifest.json','utf8')).migrations; const last=migrations.at(-1); if(!last)throw Error('empty migration manifest');
const common={gitSha,buildTime,nodeVersion:process.version,npmVersion:cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),schemaVersion:last.version,schemaChecksum:last.checksum,expectedSchemaVersion:last.version,expectedSchemaChecksum:last.checksum,appBasePath:process.env.APP_BASE_PATH||'/',viteBasePath:process.env.VITE_BASE_PATH||'/'};
for(const [dir,kind] of [['api','api'],['frontend','frontend']])fs.writeFileSync(path.join(root,dir,'release-manifest.json'),JSON.stringify({...common,kind},null,2)+'\n');
fs.writeFileSync(path.join(root,'release-manifest.json'),JSON.stringify({...common,kind:'bundle'},null,2)+'\n');
JS
for d in "$stage/api" "$stage/frontend"; do (cd "$d" && find . -type f ! -name SHA256SUMS -print0|LC_ALL=C sort -z|xargs -0 sha256sum > SHA256SUMS && sha256sum -c --strict SHA256SUMS >/dev/null); done
(cd "$stage" && find api frontend -type f -print0|LC_ALL=C sort -z|xargs -0 sha256sum > SHA256SUMS && sha256sum release-manifest.json >> SHA256SUMS && sha256sum -c --strict SHA256SUMS >/dev/null)
mv "$stage" "$out"; trap - EXIT; safe_log pass "packaged immutable release $sha"
