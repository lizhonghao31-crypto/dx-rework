#!/usr/bin/env bash
set -Eeuo pipefail
[[ "$(id -u)" == 0 && $# == 0 ]] || { echo 'Run the installed fixed entry as root, without arguments.' >&2; exit 64; }
export DX_REWORK_ROOT=/opt/dx-rework
tool="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "$tool" == /opt/dx-rework-release-tools/* && "$(stat -c %U "$tool")" == root ]]
source "$tool/scripts/deploy/lib.sh"
expected_sha="${DX_REWORK_EXPECTED_MAIN_SHA:-}"
[[ -z "$expected_sha" ]] || require_sha "$expected_sha"
state=/opt/dx-rework-release-state
[[ -d "$state" && ! -L "$state" && "$(stat -c %U "$state")" == root && "$(stat -c %a "$state")" == 700 ]]
DX_REWORK_NODE_BIN="$(cat "$state/node-binary")"
[[ "$DX_REWORK_NODE_BIN" == /* && -f "$DX_REWORK_NODE_BIN" && ! -L "$DX_REWORK_NODE_BIN" && "$(stat -c %U "$DX_REWORK_NODE_BIN")" == root && -x "$DX_REWORK_NODE_BIN" ]]
assert_root_node "$DX_REWORK_NODE_BIN"
DX_REWORK_SERVER_NAME=dxerp.org.cn
[[ -f "$DX_ROOT/locks/release.lock" && ! -L "$DX_ROOT/locks/release.lock" ]]
exec 9>"$DX_ROOT/locks/release.lock"
flock -n 9 || die 'deployment lock is held; no release work started'
export DX_REWORK_LOCK_FD=9
export PATH="$(dirname "$DX_REWORK_NODE_BIN"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
config="$(cat "$state/nginx-config")"
[[ "$config" == /etc/nginx/* && "$config" != *..* ]]
if [[ "$(cat "$state/phase")" == installed-unconverted || "$(cat "$state/phase")" == maintenance-* ]]; then
  die 'MAINTENANCE_REQUIRED: use the fixed dx-rework-maintenance-update entry; no candidate or traffic change was started'
fi
[[ -L "$config" && "$(readlink -f "$config")" == "$state/"* ]] || die 'online nginx installation is incomplete'
[[ ! -e "$DX_ROOT/shared/release-switch.lock" ]] || die 'existing maintenance state must be resolved before online release'

worker() {
  (cd /; runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$PATH" DX_REWORK_LOCK_FD=9 DX_REWORK_EXPECTED_MAIN_SHA="$expected_sha" \
    bash "$tool/scripts/deploy/$1" "${@:2}")
}
verify() {
  local port="$1" sha="$2" version
  curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$port/health/ready" >/dev/null || return
  curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsSI "http://127.0.0.1:$port/health/ready" | tr -d '\r' | grep -qi '^X-Dx-Release-Protocol: 2$' || return
  version="$(curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$port/version")" || return
  node -e 'const v=JSON.parse(process.argv[1]);if(v.gitSha!==process.argv[2])process.exit(1)' "$version" "$sha"
}
warm() {
  local i
  for i in {1..20}; do if verify "$1" "$2"; then return 0; fi; sleep 1; done
  return 1
}
static_readable() {
  python3 "$tool/scripts/deploy/static-release.py" readable "$DX_ROOT/frontend/releases/$1"
}
public_verify() {
  local version i
  for i in {1..5}; do
    if version="$(curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS --resolve "$DX_REWORK_SERVER_NAME:443:127.0.0.1" "https://$DX_REWORK_SERVER_NAME/version")" && node -e 'if(JSON.parse(process.argv[1]).gitSha!==process.argv[2])process.exit(1)' "$version" "$1"; then
      static_readable "$1" && python3 "$tool/scripts/deploy/static-release.py" http "$DX_ROOT/frontend/releases/$1" dxerp.org.cn && return 0
    fi
    sleep 1
  done
  return 1
}
link_config() {
  local target="$1" temporary="$state/config-link.tmp.$$"
  [[ "$target" == "$state/"* && -f "$target" && ! -L "$target" ]] || return 1
  ln -s -- "$target" "$temporary"
  mv -Tf "$temporary" "$config"
}
phase() {
  printf '%s\n' "$1" > "$state/phase.tmp"
  mv -Tf "$state/phase.tmp" "$state/phase"
}

current_phase="$(cat "$state/phase")"
resume=false
case "$current_phase" in prepared|switching|switched|rolling-back) resume=true ;; esac
receipt="$state/active.json"
if [[ "$resume" == true ]]; then receipt="$state/previous-active.json"; fi
readarray -t active < <(node -e 'const s=require(process.argv[1]);console.log(s.sha);console.log(s.port)' "$receipt")
active_sha="${active[0]}"; active_port="${active[1]}"
require_sha "$active_sha"
[[ "$active_port" == 3201 || "$active_port" == 3203 ]]

# Finish the frozen candidate before fetching a newer main. All identifying
# receipts are persisted before a candidate process can occupy the other port.
if [[ "$resume" == true ]]; then
  candidate_sha="$(cat "$state/candidate-sha")"; candidate_port="$(cat "$state/candidate-port")"
  require_sha "$candidate_sha"
  [[ -z "$expected_sha" || "$candidate_sha" == "$expected_sha" ]] || die 'frozen candidate differs from expected main SHA; routing unchanged'
  [[ "$candidate_port" == 3201 || "$candidate_port" == 3203 ]]
else
  verify "$active_port" "$active_sha" || die 'BOOTSTRAP_REQUIRED: active runtime must support background lease and unchanged full schema'
  snapshot="$(mktemp -d /tmp/dx-main-update.XXXXXX)"
  chown dxrework:dxrework "$snapshot"
  trap 'rm -rf -- "${snapshot:-}"' EXIT
  worker prepare-online-candidate.sh "$snapshot"
  candidate_sha="$(cat "$snapshot/CANDIDATE_SHA")"
  require_sha "$candidate_sha"
  if [[ "$candidate_sha" == "$active_sha" ]]; then
    public_verify "$active_sha" || die 'active public generation is unhealthy'
    safe_log pass "already current: $active_sha"
    exit 0
  fi
  if [[ "$active_port" == 3201 ]]; then candidate_port=3203; else candidate_port=3201; fi
  printf '%s\n' "$candidate_sha" > "$state/candidate-sha"
  printf '%s\n' "$candidate_port" > "$state/candidate-port"
  readlink -f "$config" > "$state/previous-config"
  cp "$state/active.json" "$state/previous-active.json"
  phase prepared
fi
# Do not gate an interrupted rollback on the rejected candidate's readability.
case "$(cat "$state/phase")" in
  prepared|switching)
    static_readable "$candidate_sha"
    static_readable "$active_sha"
    ;;
esac
if [[ "$(cat "$state/phase")" == prepared ]]; then
  worker start-online-slot.sh start "$candidate_sha" "$candidate_port"
  if ! warm "$candidate_port" "$candidate_sha"; then
    worker start-online-slot.sh stop "$candidate_sha" "$candidate_port"
    phase reverted
    die 'candidate failed warmup; old generation remains active'
  fi
  node "$tool/scripts/deploy/render-online-nginx.mjs" "$state/nginx-template.conf" "$state/$candidate_sha.conf" "$DX_ROOT/frontend/releases/$candidate_sha" "$candidate_port"
  node "$tool/scripts/deploy/nginx-workers.mjs" > "$state/old-workers.json"
  phase switching
fi
if [[ "$(cat "$state/phase")" == switching ]]; then
  link_config "$state/$candidate_sha.conf"
  if ! nginx -t || ! nginx -s reload; then
    node "$tool/scripts/deploy/nginx-workers.mjs" > "$state/rejected-workers.json"
    link_config "$(cat "$state/previous-config")"
    nginx -t && nginx -s reload || die 'switch routing recovery remains pending; both slots retained'
    public_verify "$active_sha" || die 'previous public generation verification remains pending; both slots retained'
    node "$tool/scripts/deploy/drain-nginx-workers.mjs" "$state/rejected-workers.json"
    worker start-online-slot.sh stop "$candidate_sha" "$candidate_port"
    phase reverted
    die 'nginx rejected candidate; previous config restored and verified'
  fi
  phase switched
fi

rollback() {
  # Schema is identical; rollback is application-only and never restores a DB
  # backup over requests accepted by either version.
  phase rolling-back
  worker start-online-slot.sh start "$active_sha" "$active_port" || return
  warm "$active_port" "$active_sha" || return
  node "$tool/scripts/deploy/nginx-workers.mjs" > "$state/rollback-workers.json"
  link_config "$(cat "$state/previous-config")"
  nginx -t && nginx -s reload || return
  public_verify "$active_sha" || return
  node "$tool/scripts/deploy/drain-nginx-workers.mjs" "$state/rollback-workers.json" || return
  worker start-online-slot.sh stop "$candidate_sha" "$candidate_port" || return
  worker commit-online-generation.sh "$active_sha" || return
  cp "$state/previous-active.json" "$state/active.json.tmp"
  mv -Tf "$state/active.json.tmp" "$state/active.json"
  phase reverted
}
if [[ "$(cat "$state/phase")" == rolling-back ]]; then
  rollback || die 'rollback remains pending; both slots retained'
  die 'interrupted rollback completed; previous generation verified'
fi
if ! verify "$candidate_port" "$candidate_sha" || ! public_verify "$candidate_sha"; then
  rollback || die 'rollback pending; both slots retained; inspect release state'
  die 'candidate verification failed; prior generation restored and verified'
fi
node "$tool/scripts/deploy/drain-nginx-workers.mjs" "$state/old-workers.json"
if ! verify "$candidate_port" "$candidate_sha"; then
  rollback || die 'rollback pending; both slots retained'
  die 'candidate failed during drain; old generation restored'
fi
worker start-online-slot.sh stop "$active_sha" "$active_port"
if ! verify "$candidate_port" "$candidate_sha" || ! public_verify "$candidate_sha"; then
  rollback || die 'rollback pending; retain both immutable generations'
  die 'post-drain verification failed; prior generation restored'
fi
worker commit-online-generation.sh "$candidate_sha"
node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({sha:process.argv[2],port:Number(process.argv[3])})+"\n",{mode:0o600})' "$state/active.json.tmp" "$candidate_sha" "$candidate_port"
mv -Tf "$state/active.json.tmp" "$state/active.json"
phase completed
worker save-online-processes.sh
safe_log pass "ONLINE_RELEASE_SUCCESS sha=$candidate_sha port=$candidate_port"
