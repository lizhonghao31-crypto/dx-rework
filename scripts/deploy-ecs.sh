#!/usr/bin/env bash
set -euo pipefail

DX_ROOT=/opt/dx-rework
SOURCE_ROOT="$(cd "$(dirname "$0")/.." && pwd -P)"
EXPECTED_ORIGIN='git@github.com:lizhonghao31-crypto/dx-rework.git'
DEPS_MARKER="$DX_ROOT/shared/build-package-lock.sha256"

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
build_root="$DX_ROOT/incoming/ecs-build-$sha-$$"
bundle="$build_root/$sha"
trap 'rm -rf -- "$build_root"' EXIT

printf '=== dx-rework deploy %s ===\n' "$sha"
printf '1/3 dependencies and build\n'
lock_hash="$(sha256sum package-lock.json | awk '{print $1}')"
deps_ready=false
if [[ -d node_modules && ! -L node_modules \
      && -f node_modules/typescript/lib/tsc.js \
      && -f node_modules/vite/bin/vite.js \
      && -x node_modules/.bin/tsc \
      && -x node_modules/.bin/vite \
      && -f "$DEPS_MARKER" \
      && "$(cat "$DEPS_MARKER")" == "$lock_hash" ]]; then
  deps_ready=true
fi

if [[ "$deps_ready" == true ]]; then
  printf 'dependencies unchanged; reuse persistent source node_modules\n'
else
  printf 'dependencies missing/changed; repair once\n'
  [[ -L node_modules ]] && rm -f node_modules
  set +e
  npm install --prefer-offline --no-audit --no-fund --progress=false
  npm_rc=$?
  set -e

  if [[ "$npm_rc" != 0 ]]; then
    printf 'npm returned %s; checking whether the dependency tree is nevertheless usable\n' "$npm_rc"
  fi

  [[ -f node_modules/typescript/lib/tsc.js \
     && -f node_modules/vite/bin/vite.js \
     && -x node_modules/.bin/tsc \
     && -x node_modules/.bin/vite ]] || die 'dependency install incomplete'
  npm ls --depth=0 --workspaces --include-workspace-root >/dev/null || die 'dependency tree validation failed'
  git diff --quiet -- package.json package-lock.json || die 'dependency repair changed package metadata'

  printf '%s\n' "$lock_hash" > "${DEPS_MARKER}.tmp.$$"
  mv "${DEPS_MARKER}.tmp.$$" "$DEPS_MARKER"
fi

APP_BASE_PATH="$APP_BASE_PATH" VITE_BASE_PATH="$APP_BASE_PATH" npm run build

printf '2/3 package release\n'
APP_BASE_PATH="$APP_BASE_PATH" \
VITE_BASE_PATH="$APP_BASE_PATH" \
DX_REWORK_BUILD_ROOT="$DX_ROOT/incoming" \
  "$SOURCE_ROOT/scripts/deploy/package-release.sh" "$sha" "$build_time" "$bundle"

printf '3/3 release\n'
DX_REWORK_APPLY=true \
DX_REWORK_ENVIRONMENT_APPROVED=true \
DX_REWORK_CONFIRM_RELEASE="$sha" \
DX_REWORK_APPLY_MIGRATIONS=true \
DX_REWORK_EVIDENCE_DIR="$DX_ROOT/evidence/ecs-$sha" \
  "$SOURCE_ROOT/scripts/deploy/release.sh" "$sha" "$bundle"

printf 'DEPLOY SUCCESS: %s\n' "$sha"
