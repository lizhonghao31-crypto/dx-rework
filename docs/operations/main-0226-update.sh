#!/usr/bin/env bash
# One-off main 0225 -> 0226 delivery. User executes on ECS; never source this file.
set -Eeuo pipefail
umask 077
[[ "$(id -u)" == 0 && $# == 1 && "$1" =~ ^[0-9a-f]{40}$ ]] || {
  echo 'Usage: sudo bash main-0226-update.sh APPROVED_MERGED_MAIN_SHA' >&2; exit 64;
}
target="$1"
base=8c2beb55925c15d93e37e7cfaa42b635426a455b
schema=0226_external_revision_preserve_handler
state=/opt/dx-rework-release-state
[[ -d "$state" && ! -L "$state" && "$(stat -c %U "$state")" == root && "$(stat -c %a "$state")" == 700 ]]
[[ "$(cat "$state/phase")" == completed ]] || {
  echo 'Unfinished release phase: retain receipts and inspect before continuing.' >&2; exit 1;
}
node_binary="$(cat "$state/node-binary")"
nginx_config="$(cat "$state/nginx-config")"
logdir="$(mktemp -d /var/tmp/dx-main-0226.XXXXXX)"
exec > >(tee "$logdir/update.log") 2>&1
on_exit() {
  local rc=$?
  if (( rc != 0 )); then
    printf 'MAIN_0226_UPDATE_FAILED rc=%s evidence=%s\n' "$rc" "$logdir"
    for name in phase candidate-sha candidate-port active.json previous-active.json; do
      if [[ -f "$state/$name" ]]; then printf '%s: ' "$name"; cat "$state/$name"; printf '\n'; fi
    done
    echo 'Keep candidate, backup.log, backups and receipts. Do not run old code after committed DDL.'
  fi
}
trap on_exit EXIT
python3 - "$state/active.json" "$base" <<'PY'
import json, pathlib, sys
active=json.loads(pathlib.Path(sys.argv[1]).read_text())
assert active == {'sha':sys.argv[2], 'port':3203}, 'Unexpected active SHA/port; STOP'
assert pathlib.Path('/opt/dx-rework/current').resolve() == pathlib.Path('/opt/dx-rework/releases')/sys.argv[2]
print('VERIFIED_BASE', active)
PY
repository="$(mktemp -d /tmp/dx-main-0226-source.XXXXXX)"
chown dxrework:dxrework "$repository"
git_remote() { (cd /; runuser -u dxrework -- git -C "$repository" "$@"); }
git_remote init --quiet
git_remote config core.sshCommand 'ssh -i /home/dxrework/.ssh/github_dx_rework -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=15'
git_remote remote add origin git@github.com:lizhonghao31-crypto/dx-rework.git
timeout 180 runuser -u dxrework -- git -C "$repository" fetch --quiet --no-tags origin refs/heads/main:refs/remotes/origin/main
[[ "$(git_remote rev-parse refs/remotes/origin/main)" == "$target" ]] || {
  echo 'Remote main differs from approved target; STOP before tool installation.' >&2; exit 1;
}
git_remote checkout --quiet --detach "$target"
git_remote fsck --full --no-reflogs
[[ -z "$(git_remote status --porcelain)" ]]
source "$repository/scripts/deploy/lib.sh"
assert_root_node "$node_binary"
[[ "$nginx_config" == /etc/nginx/* && "$nginx_config" != *..* && -f "$nginx_config" ]]
nginx -t
# Only read-only SQL/config probes before installing tools or entering maintenance.
(cd /; runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$(dirname "$node_binary"):/usr/local/bin:/usr/bin:/bin" \
  bash -s -- "$repository" "$node_binary" "$base" <<'WORK_PREFLIGHT'
set -Eeuo pipefail
repository="$1"; expected_node="$2"; base="$3"
source "$repository/scripts/deploy/lib.sh"
load_app_config
load_database_tool_config
[[ "$(approved_node_bin)" == "$expected_node" ]]
[[ "$(node_exec -p 'process.versions.node.split(".")[0]')" == 22 && "$(npm --version | cut -d. -f1)" == 10 ]]
command -v pm2 >/dev/null
assert_postgres_toolchain "$DATABASE_URL"
# The fresh checkout has no dependencies. Use the existing pg loader via a
# disposable symlink, removed before the installer's clean-checkout assertion.
ln -s /opt/dx-rework/current/node_modules "$repository/node_modules"
trap 'unlink "$repository/node_modules"' EXIT
node_exec "$repository/scripts/deploy/database-state.mjs" verify-current "/opt/dx-rework/releases/$base/apps/api/src/platform/migration-manifest.json"
node_exec "$repository/scripts/deploy/check-main-maintenance-plan.mjs" "$repository"
[[ "$(node_exec -p "JSON.parse(require('fs').readFileSync('$repository/apps/api/src/platform/migration-manifest.json')).migrations.at(-1).version")" == 0226_external_revision_preserve_handler ]]
bytes="$(pg_exec psql "$DATABASE_URL" -XAtqc 'select pg_database_size(current_database())')"
free="$(df -Pk /opt/dx-rework | awk 'NR==2 {print $4}')"
[[ "$bytes" =~ ^[0-9]+$ && "$free" =~ ^[0-9]+$ ]]
(( free * 1024 >= bytes * 3 && free * 1024 >= 268435456 ))
printf 'PRECHECK_PASSED Node=%s npm=%s pg_dump=%s\n' "$(node_exec --version)" "$(npm --version)" "$(pg_exec pg_dump --version)"
df -h /opt/dx-rework /tmp
WORK_PREFLIGHT
)
[[ -z "$(git_remote status --porcelain)" ]]
# Refresh main tools only. Do not invoke install-update-entries.sh/Acceptance install.
bash "$repository/scripts/deploy/install-online-entry.sh" "$node_binary" "$nginx_config"
export DX_REWORK_EXPECTED_MAIN_SHA="$target"
/usr/local/bin/dx-rework-maintenance-update
python3 - "$state" "$target" "$schema" <<'PY'
import json, pathlib, sys, urllib.request
state=pathlib.Path(sys.argv[1]); target=sys.argv[2]; schema=sys.argv[3]
assert (state/'phase').read_text().strip() == 'completed'
assert json.loads((state/'active.json').read_text()) == {'sha':target,'port':3203}
assert pathlib.Path('/opt/dx-rework/current').resolve() == pathlib.Path('/opt/dx-rework/releases')/target
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
with opener.open('http://127.0.0.1:3203/version',timeout=5) as r: version=json.load(r)
assert version['gitSha']==target and version['schemaVersion']==schema and version['expectedSchemaVersion']==schema
with opener.open('http://127.0.0.1:3203/health/ready',timeout=5) as r: assert r.status==200
print('VERIFIED_VERSION',json.dumps(version))
PY
curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS --resolve dxerp.org.cn:443:127.0.0.1 https://dxerp.org.cn/version \
  | "$node_binary" -e 'let s="";process.stdin.on("data",x=>s+=x).on("end",()=>{const v=JSON.parse(s);if(v.gitSha!==process.argv[1]||v.schemaVersion!==process.argv[2])process.exit(1);console.log("VERIFIED_PUBLIC_VERSION",s)})' "$target" "$schema"
printf 'MAIN_0226_UPDATE_FINISHED sha=%s schema=%s port=3203 evidence=%s source=%s\n' "$target" "$schema" "$logdir" "$repository"
