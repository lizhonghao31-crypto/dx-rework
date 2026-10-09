#!/usr/bin/env bash
set -Eeuo pipefail
source "$(dirname "$0")/lib.sh"
[[ "$(id -un)" == dxrework && ( $# == 1 || $# == 2 || $# == 3 ) ]] || die 'candidate preparation requires dxrework and output directory'
out="$1"
mode="${2:-online}"; requested="${3:-}"
[[ "$mode" == online || "$mode" == maintenance || "$mode" == recovery ]] || die 'invalid preparation mode'
if [[ "$mode" == recovery ]]; then require_sha "$requested"; else [[ -z "$requested" ]]; fi
kernel="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "$out" == /tmp/dx-main-update.* && -d "$out" && ! -L "$out" ]] || die 'unsafe candidate output'
acquire_lock "$DX_ROOT/locks/release.lock"
load_app_config
load_node_config
export PATH="$(dirname "$DX_REWORK_NODE_BIN"):/usr/local/bin:/usr/bin:/bin"
export npm_config_fetch_retries=1 npm_config_fetch_timeout=30000 npm_config_fetch_retry_maxtimeout=10000
[[ "$(node -p 'process.versions.node.split(".")[0]')" == 22 && "$(npm --version | cut -d. -f1)" == 10 ]] || die 'Node22/npm10 required'
repository="$(mktemp -d /tmp/dx-main-git.XXXXXX)"
trap 'rm -rf -- "$repository"' EXIT
git -C "$repository" init --quiet
git -C "$repository" config core.sshCommand 'ssh -i /home/dxrework/.ssh/github_dx_rework -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15'
git -C "$repository" remote add origin git@github.com:lizhonghao31-crypto/dx-rework.git
timeout 180 git -C "$repository" fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main
sha="${requested:-$(git -C "$repository" rev-parse refs/remotes/origin/main)}"
require_sha "$sha"
git -C "$repository" merge-base --is-ancestor "$sha" refs/remotes/origin/main
git -C "$repository" fsck --full --no-reflogs >/dev/null
git -C "$repository" archive "$sha" | tar -x -C "$out"

# Online release admits identical full histories only. No skip-current flag,
# DDL rewrite, automatic migration or assumption that a checksum means safety.
if [[ "$mode" == maintenance ]]; then
  DATABASE_URL="$DATABASE_URL" node_exec "$kernel/scripts/deploy/check-main-maintenance-plan.mjs" "$out"
else
  if ! DATABASE_URL="$DATABASE_URL" node_exec "$kernel/scripts/deploy/database-state.mjs" verify-current "$out/apps/api/src/platform/migration-manifest.json"; then
    die 'ONLINE_SCHEMA_CHANGE_REFUSED: use the fixed dx-rework-maintenance-update entry; running service untouched'
  fi
  if [[ "$mode" == online ]]; then
    cmp "$DX_ROOT/current/apps/api/src/platform/migration-manifest.json" "$out/apps/api/src/platform/migration-manifest.json" || die 'ONLINE_SCHEMA_CHANGE_REFUSED: staged migration plan required'
  fi
fi

bundle="$DX_ROOT/candidates/$sha"
if [[ ! -d "$bundle" ]]; then
  cd "$out"
  bash "$kernel/scripts/deploy/prepare-build-dependencies.sh" "$out" "$DX_ROOT/current"
  export VITE_BASE_PATH="$APP_BASE_PATH"
  timeout 300 npm run build:packages
  timeout 300 npm run build --workspace @dx-rework/api
  timeout 300 npm run build --workspace @dx-rework/web
  DX_REWORK_BUILD_ROOT="$DX_ROOT/candidates" bash "$kernel/scripts/deploy/package-release.sh" "$sha" "$(date -u +%FT%TZ)" "$bundle"
fi
assert_release "$bundle/api" "$sha" "$DX_ROOT/candidates"
assert_release "$bundle/frontend" "$sha" "$DX_ROOT/candidates"
bash "$bundle/api/scripts/deploy/verify-runtime.sh" "$bundle/api"
if [[ "$mode" != recovery ]]; then
  [[ "$(manifest_field "$bundle/api/release-manifest.json" releaseProtocol)" == 2 ]] || die 'candidate does not implement the audited release protocol'
fi
bash "$kernel/scripts/deploy/install-release.sh" "$sha" "$bundle" register-only
printf '%s\n' "$sha" > "$out/CANDIDATE_SHA"
