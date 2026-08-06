#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
[[ $# == 3 ]] || die 'usage: build-release.sh SHA ISO_BUILD_TIME OUTPUT_DIR'
sha="$1"; build_time="$2"; out="$(assert_safe_path "$3" "${DX_REWORK_BUILD_ROOT:-$PWD/.pr17-build}")"
require_sha "$sha"; date -d "$build_time" -u +%FT%TZ >/dev/null || die 'invalid ISO build time'
[[ "$(git rev-parse HEAD)" == "$sha" ]] || die 'Head mismatch'; [[ -z "$(git status --porcelain)" ]] || die 'dirty worktree'; [[ ! -e "$out" && ! -L "$out" ]] || die 'output already exists'
[[ "$(node -p 'process.versions.node.split(`.`)[0]')" == 22 ]] || die 'Node 22 required'; [[ "$(npm --version|cut -d. -f1)" == 10 ]] || die 'npm 10 required'
npm ci; npm run build
stage="${out}.tmp.$$"; trap 'rm -rf -- "$stage"' EXIT; mkdir -p "$stage/api" "$stage/frontend"
cp -a apps/api/dist apps/api/package.json "$stage/api/"; cp -a apps/web/dist/. "$stage/frontend/"
schema="$(node scripts/check-migrations.mjs --print-schema-version 2>/dev/null || find migrations -type f 2>/dev/null|sort|tail -1|sed 's#.*/##' || true)"
node - "$stage/release-manifest.json" "$sha" "$build_time" "${schema:-unknown}" <<'JS'
const fs=require('fs'); const [p,gitSha,buildTime,schemaVersion]=process.argv.slice(2); const cp=require('child_process');
const m={gitSha,buildTime,nodeVersion:process.version,npmVersion:cp.execFileSync('npm',['--version'],{encoding:'utf8'}).trim(),schemaVersion,appBasePath:process.env.APP_BASE_PATH||'/',viteBasePath:process.env.VITE_BASE_PATH||'/'};
fs.writeFileSync(p,JSON.stringify(m,null,2)+'\n');
JS
(cd "$stage" && touch .build-complete && find . -type f ! -name SHA256SUMS -print0|LC_ALL=C sort -z|xargs -0 sha256sum > SHA256SUMS && sha256sum --check --strict SHA256SUMS >/dev/null)
mv "$stage" "$out"; trap - EXIT; safe_log pass "release built for $sha"
