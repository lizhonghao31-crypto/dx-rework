#!/usr/bin/env bash
# User-run production-only delivery. Never source into a login shell.
set -Eeuo pipefail
umask 077
[[ "$(id -u)" == 0 && $# == 2 && "$2" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'Usage: bash contract-price-update.sh --approved-sha MERGED_MAIN_SHA | --approved-tree REVIEWED_TREE_SHA' >&2; exit 64;
}
approval_mode="$1"; approved="$2"
[[ "$approval_mode" == --approved-sha || "$approval_mode" == --approved-tree ]] || exit 64
state=/opt/dx-rework-release-state
schema=0229_sourcing_price_reapplications
[[ -d "$state" && ! -L "$state" && "$(stat -c %U "$state")" == root && "$(stat -c %a "$state")" == 700 ]]
node_binary="$(cat "$state/node-binary")"
nginx_config="$(cat "$state/nginx-config")"
phase_before="$(cat "$state/phase")"
resuming=false
case "$phase_before" in
  maintenance-prepared|maintenance-draining|maintenance-drained|maintenance-stopped|maintenance-backed-up|maintenance-migrating|maintenance-migrated|maintenance-activating) resuming=true ;;
esac
logdir="$(mktemp -d /var/tmp/dx-contract-price.XXXXXX)"
exec > >(tee "$logdir/update.log") 2>&1
on_exit() {
  local rc=$?
  if [[ -n "${repository:-}" && -L "$repository/node_modules" && "$(readlink "$repository/node_modules")" == /opt/dx-rework/current/node_modules ]]; then unlink "$repository/node_modules"; fi
  if (( rc != 0 )); then
    printf 'CONTRACT_PRICE_UPDATE_FAILED rc=%s evidence=%s\n' "$rc" "$logdir"
    for name in phase candidate-sha candidate-port active.json previous-active.json; do
      if [[ -f "$state/$name" ]]; then printf '%s: ' "$name"; cat "$state/$name"; printf '\n'; fi
    done
    echo 'Keep receipts/candidate/backup.log and backups. After committed DDL, retry the SAME frozen target; never restore old code over the new schema.'
  fi
}
trap on_exit EXIT
repository="$(mktemp -d /tmp/dx-contract-price-source.XXXXXX)"
chown dxrework:dxrework "$repository"
git_remote() { (cd /; runuser -u dxrework -- git -C "$repository" "$@"); }
git_remote init --quiet
git_remote config core.sshCommand 'ssh -i /home/dxrework/.ssh/github_dx_rework -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15'
git_remote remote add origin git@github.com:lizhonghao31-crypto/dx-rework.git
timeout 180 runuser -u dxrework -- git -C "$repository" fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main
target="$(git_remote rev-parse refs/remotes/origin/main)"
if [[ "$resuming" == true ]]; then target="$(cat "$state/candidate-sha")"; fi
[[ "$target" =~ ^[0-9a-f]{40}$ ]]
git_remote merge-base --is-ancestor "$target" refs/remotes/origin/main
if [[ "$approval_mode" == --approved-sha ]]; then
  [[ "$target" == "$approved" ]] || { echo 'MAIN_TARGET_NOT_APPROVED: remote main differs; no tools or traffic change.' >&2; exit 1; }
else
  [[ "$(git_remote rev-parse "$target^{tree}")" == "$approved" ]] || { echo 'MAIN_TREE_NOT_APPROVED: merge the reviewed PR first; remote main differs, no tools or traffic change.' >&2; exit 1; }
fi
git_remote checkout --quiet --detach "$target"
git_remote fsck --full --no-reflogs
[[ -z "$(git_remote status --porcelain --untracked-files=all)" ]]
# Freeze and reverify the exact fetched checkout before any Root source execution.
chown -R root:root "$repository"
chmod -R u=rwX,go=rX "$repository"
git_verified() { git -C "$repository" "$@"; }
[[ "$(git_verified rev-parse HEAD)" == "$target" ]]
if [[ "$approval_mode" == --approved-tree ]]; then [[ "$(git_verified rev-parse 'HEAD^{tree}')" == "$approved" ]]; fi
git_verified fsck --full --no-reflogs
[[ -z "$(git_verified status --porcelain --untracked-files=all)" ]]
source "$repository/scripts/deploy/lib.sh"
assert_root_node "$node_binary"
[[ "$nginx_config" == /etc/nginx/* && "$nginx_config" != *..* && -f "$nginx_config" ]]
nginx -t
[[ "$(cat "$state/phase")" == "$phase_before" ]] || { echo 'Release phase changed while fetching; retain receipts and retry after the other release finishes.' >&2; exit 1; }
case "$phase_before" in
  completed|reverted|maintenance-reverted) ;;
  maintenance-prepared|maintenance-draining|maintenance-drained|maintenance-stopped|maintenance-backed-up|maintenance-migrating|maintenance-migrated|maintenance-activating)
    [[ "$(cat "$state/candidate-sha")" == "$target" ]] || { echo 'FROZEN_TARGET_MISMATCH: retain maintenance and receipts; do not replace the interrupted candidate.' >&2; exit 1; } ;;
  *) echo 'Unfinished online transition or unconverted installation: retain receipts and finish its original entry first.' >&2; exit 1 ;;
esac
# Only delegated dxrework loads runtime dependencies and database credentials.
ln -s /opt/dx-rework/current/node_modules "$repository/node_modules"
(cd /; runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$(dirname "$node_binary"):/usr/local/bin:/usr/bin:/bin" \
  bash -s -- "$repository" "$node_binary" <<'WORK_PREFLIGHT'
set -Eeuo pipefail
repository="$1"; expected_node="$2"
source "$repository/scripts/deploy/lib.sh"
load_deploy_config
[[ "${DX_REWORK_PROFILE:-}" == production ]]
load_app_config
load_database_tool_config
[[ "$(approved_node_bin)" == "$expected_node" ]]
[[ "$(node_exec -p 'process.versions.node.split(".")[0]')" == 22 && "$(npm --version | cut -d. -f1)" == 10 ]]
command -v pm2 >/dev/null
assert_postgres_toolchain "$DATABASE_URL"
[[ "$(node_exec -p "JSON.parse(require('fs').readFileSync('$repository/apps/api/src/platform/migration-manifest.json')).migrations.at(-1).version")" == 0229_sourcing_price_reapplications ]]
plan="$(node_exec "$repository/scripts/deploy/check-main-maintenance-plan.mjs" "$repository")"
node_exec -e 'const p=JSON.parse(process.argv[1]);if(![[],["0228_sourcing_contract_return_cycles","0229_sourcing_price_reapplications"],["0229_sourcing_price_reapplications"]].some(expected=>JSON.stringify(expected)===JSON.stringify(p.pending)))throw Error("Only main0227->0229, main0228->0229, or already-current history is supported");console.log("PRECHECK_PLAN",JSON.stringify(p));console.log("PRECHECK_MODE",p.pending.length?"maintenance":"online")' "$plan"
df -h /opt/dx-rework /tmp
WORK_PREFLIGHT
) | tee "$logdir/preflight.log"
release_mode="$(awk '$1=="PRECHECK_MODE" {print $2}' "$logdir/preflight.log")"
[[ "$release_mode" == maintenance || "$release_mode" == online ]]
unlink "$repository/node_modules"
[[ -z "$(git_verified status --porcelain --untracked-files=all)" ]]
[[ "$(cat "$state/phase")" == "$phase_before" ]] || { echo 'Release phase changed during preflight; retain receipts and retry after the other release finishes.' >&2; exit 1; }
# Main only: do not invoke install-update-entries.sh or any Acceptance installer.
bash "$repository/scripts/deploy/install-online-entry.sh" "$node_binary" "$nginx_config"
tools="/opt/dx-rework-release-tools/$target"
cmp "$repository/scripts/deploy/main-maintenance-plans.json" "$tools/scripts/deploy/main-maintenance-plans.json"
grep -F -- "$tools/scripts/deploy/update-main-maintenance.sh" /usr/local/bin/dx-rework-maintenance-update >/dev/null
grep -F -- "$tools/scripts/deploy/update-main-online.sh" /usr/local/bin/dx-rework-deploy >/dev/null
export DX_REWORK_EXPECTED_MAIN_SHA="$target"
active_sha="$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["sha"])' "$state/active.json")"
if [[ "$phase_before" == completed && "$active_sha" == "$target" && "$release_mode" == online ]]; then
  printf 'ALREADY_CURRENT sha=%s; no application build, migration or service switch requested\n' "$target"
elif [[ "$resuming" == true || "$release_mode" == maintenance ]]; then
  /usr/local/bin/dx-rework-maintenance-update
else
  /usr/local/bin/dx-rework-deploy
fi
# Dynamic receipt/port: do not assume an old active SHA or port3203.
python3 - "$state" "$target" "$schema" <<'WORK_VERIFY'
import json, pathlib, sys, urllib.request
state=pathlib.Path(sys.argv[1]); target=sys.argv[2]; schema=sys.argv[3]
assert (state/'phase').read_text().strip()=='completed'
active=json.loads((state/'active.json').read_text())
assert active['sha']==target and active['port'] in (3201,3203)
assert pathlib.Path('/opt/dx-rework/current').resolve()==pathlib.Path('/opt/dx-rework/releases')/target
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open('http://127.0.0.1:%s/version'%active['port'],timeout=5) as r: version=json.load(r)
assert version['gitSha']==target and version['schemaVersion']==schema and version['expectedSchemaVersion']==schema
with opener.open('http://127.0.0.1:%s/health/ready'%active['port'],timeout=5) as r:
 assert r.status==200 and r.headers.get('X-Dx-Release-Protocol')=='2'
print('VERIFIED_VERSION',json.dumps(version)); print('VERIFIED_ACTIVE',json.dumps(active))
WORK_VERIFY
python3 "$tools/scripts/deploy/static-release.py" readable "/opt/dx-rework/frontend/releases/$target"
python3 "$tools/scripts/deploy/static-release.py" http "/opt/dx-rework/frontend/releases/$target" dxerp.org.cn
curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS --resolve dxerp.org.cn:443:127.0.0.1 https://dxerp.org.cn/version \
  | "$node_binary" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const v=JSON.parse(s);if(v.gitSha!==process.argv[1]||v.schemaVersion!==process.argv[2]||v.expectedSchemaVersion!==process.argv[2])process.exit(1);console.log("VERIFIED_PUBLIC_VERSION",s)})' "$target" "$schema"
printf 'CONTRACT_PRICE_UPDATE_FINISHED sha=%s schema=%s evidence=%s source=%s\n' "$target" "$schema" "$logdir" "$repository"
