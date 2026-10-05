#!/usr/bin/env bash
# Explicit controlled maintenance, never an automatic escalation from online mode.
set -Eeuo pipefail
[[ "$(id -u)" == 0 && $# == 0 ]] || exit 64
export DX_REWORK_ROOT=/opt/dx-rework
tool="$(cd "$(dirname "$0")/../.." && pwd -P)"
[[ "$tool" == /opt/dx-rework-release-tools/* && "$(stat -c %U "$tool")" == root ]]
source "$tool/scripts/deploy/lib.sh"
state=/opt/dx-rework-release-state
[[ -d "$state" && ! -L "$state" && "$(stat -c %U "$state")" == root && "$(stat -c %a "$state")" == 700 ]]
node_binary="$(cat "$state/node-binary")"
[[ -f "$node_binary" && ! -L "$node_binary" && -x "$node_binary" && "$(stat -c %U "$node_binary")" == root ]]
assert_root_node "$node_binary"
export PATH="$(dirname "$node_binary"):/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
config="$(cat "$state/nginx-config")"
[[ "$config" == /etc/nginx/* && "$config" != *..* ]]
[[ -f "$DX_ROOT/locks/release.lock" && ! -L "$DX_ROOT/locks/release.lock" ]]
exec 9>"$DX_ROOT/locks/release.lock"
flock -n 9 || die 'deployment lock is held; maintenance did not start'
worker() {
  (cd /; runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$PATH" DX_REWORK_LOCK_FD=9 \
    bash "$tool/scripts/deploy/$1" "${@:2}")
}
phase() { printf '%s\n' "$1" > "$state/phase.tmp"; mv -Tf "$state/phase.tmp" "$state/phase"; }
link_config() {
  [[ "$1" == "$state/"* && -f "$1" && ! -L "$1" ]] || return 1
  ln -s -- "$1" "$state/config-link.tmp.$$"
  mv -Tf "$state/config-link.tmp.$$" "$config"
}
version_matches() {
  local version
  version="$(curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$2/version")" || return
  node -e 'if(JSON.parse(process.argv[1]).gitSha!==process.argv[2])process.exit(1)' "$version" "$1"
}
warm() {
  local i
  for i in {1..20}; do
    if curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsS "http://127.0.0.1:$2/health/ready" >/dev/null && version_matches "$1" "$2"; then return 0; fi
    sleep 1
  done
  return 1
}
public_verify() {
  local version i
  for i in {1..5}; do
    if version="$(curl --noproxy '*' --connect-timeout 2 --max-time 5 -fsS --resolve dxerp.org.cn:443:127.0.0.1 https://dxerp.org.cn/version)" && node -e 'if(JSON.parse(process.argv[1]).gitSha!==process.argv[2])process.exit(1)' "$version" "$1"; then return 0; fi
    sleep 1
  done
  return 1
}
previous_phase="$(cat "$state/phase")"
case "$previous_phase" in
  prepared|switched|switching|rolling-back) die 'online transition is unfinished; resume dx-rework-update main first' ;;
esac
resume=false
case "$previous_phase" in
  maintenance-prepared|maintenance-draining|maintenance-drained|maintenance-stopped|maintenance-backed-up|maintenance-migrating|maintenance-migrated|maintenance-activating) resume=true ;;
esac
if [[ "$resume" == true ]]; then receipt="$state/previous-active.json"; else receipt="$state/active.json"; fi
readarray -t active < <(node -e 'const s=require(process.argv[1]);console.log(s.sha);console.log(s.port)' "$receipt")
active_sha="${active[0]}"; active_port="${active[1]}"
require_sha "$active_sha"
[[ "$active_port" == 3201 || "$active_port" == 3203 ]]
if [[ "$resume" != true ]]; then
  version_matches "$active_sha" "$active_port" || die 'running version changed since installation; no maintenance change started'
  snapshot="$(mktemp -d /tmp/dx-main-update.XXXXXX)"; recovery="$(mktemp -d /tmp/dx-main-update.XXXXXX)"
  chown dxrework:dxrework "$snapshot" "$recovery"
  trap 'rm -rf -- "${snapshot:-}" "${recovery:-}"' EXIT
  worker prepare-online-candidate.sh "$snapshot" maintenance
  candidate_sha="$(cat "$snapshot/CANDIDATE_SHA")"
  require_sha "$candidate_sha"
  if [[ "$candidate_sha" == "$active_sha" && "$previous_phase" != installed-unconverted ]]; then
    warm "$active_sha" "$active_port" && public_verify "$active_sha" || die 'current runtime is unhealthy'
    safe_log pass 'already current; maintenance was not entered'
    exit 0
  fi
  # Reconstruct the EXACT served previous SHA from a full independent fetch,
  # not the possibly reset/mutated production source checkout.
  worker prepare-online-candidate.sh "$recovery" recovery "$active_sha"
  worker check-main-layout.sh "$active_sha"
  printf '%s\n' "$candidate_sha" > "$state/candidate-sha"
  printf '%s\n' "$active_port" > "$state/candidate-port"
  cp "$state/active.json" "$state/previous-active.json"
  cp -L "$config" "$state/previous-active-nginx.conf"
  node "$tool/scripts/deploy/render-main-maintenance.mjs" "$state/nginx-template.conf" "$state/maintenance.conf"
  node "$tool/scripts/deploy/nginx-workers.mjs" > "$state/maintenance-workers.json"
  phase maintenance-prepared
else
  candidate_sha="$(cat "$state/candidate-sha")"
  require_sha "$candidate_sha"
fi

if [[ "$(cat "$state/phase")" == maintenance-prepared ]]; then
  [[ -f "$state/maintenance-workers.json" ]] || die 'original maintenance drain receipt is missing; service retained'
  link_config "$state/maintenance.conf"
  if ! nginx -t || ! nginx -s reload; then
    link_config "$state/previous-active-nginx.conf"
    nginx -t && nginx -s reload
    phase maintenance-reverted
    die 'maintenance routing was rejected; old runtime retained'
  fi
  phase maintenance-draining
fi
if [[ "$(cat "$state/phase")" == maintenance-draining ]]; then
  if ! node "$tool/scripts/deploy/drain-nginx-workers.mjs" "$state/maintenance-workers.json"; then
    link_config "$state/previous-active-nginx.conf"
    nginx -t && nginx -s reload || die 'request drain timed out; routing recovery needs inspection'
    public_verify "$active_sha" || die 'request drain timed out; old runtime verification failed'
    phase maintenance-reverted
    die 'request drain timed out; unchanged old runtime retained and routing restored'
  fi
  phase maintenance-drained
fi
if [[ "$(cat "$state/phase")" == maintenance-drained ]]; then
  # The receipt and drained phase survive a crash during/after this idempotent stop.
  worker stop-main-runtime.sh "$active_sha" "$active_port"
  phase maintenance-stopped
fi

restore_unchanged_old() {
  # Full history comparison is mandatory; no rollback over any committed DDL.
  worker apply-main-maintenance.sh verify "$active_sha" >/dev/null || return
  worker convert-main-aliases.sh "$active_sha" || return
  worker start-online-slot.sh start "$active_sha" "$active_port" || return
  warm "$active_sha" "$active_port" || return
  link_config "$state/previous-active-nginx.conf"
  nginx -t && nginx -s reload || return
  public_verify "$active_sha" || return
  phase maintenance-reverted
}
if [[ "$(cat "$state/phase")" == maintenance-stopped ]]; then
  if ! worker backup-main-maintenance.sh "$candidate_sha" "$active_sha" > "$state/backup.log"; then
    restore_unchanged_old || die 'backup failed and old runtime recovery needs inspection; maintenance retained'
    die 'backup failed; unchanged old database/runtime restored and verified'
  fi
  worker convert-main-aliases.sh "$active_sha"
  phase maintenance-backed-up
fi
case "$(cat "$state/phase")" in
  maintenance-backed-up|maintenance-migrating)
    phase maintenance-migrating
    if ! worker apply-main-maintenance.sh apply "$candidate_sha"; then
      restore_unchanged_old || die 'migration failed after history changed or recovery failed; keep maintenance and retry the SAME frozen candidate'
      die 'migration transaction failed; unchanged old runtime restored and verified'
    fi
    worker apply-main-maintenance.sh verify "$candidate_sha"
    phase maintenance-migrated
    ;;
esac
worker start-online-slot.sh start "$candidate_sha" "$active_port"
if ! warm "$candidate_sha" "$active_port"; then
  worker stop-main-runtime.sh "$candidate_sha" "$active_port"
  die 'candidate startup failed after migration; maintenance retained; retry SAME candidate with the fixed entry'
fi
curl --noproxy '*' --connect-timeout 2 --max-time 3 -fsSI "http://127.0.0.1:$active_port/health/ready" | tr -d '\r' | grep -qi '^X-Dx-Release-Protocol: 2$' || die 'new runtime protocol mismatch; maintenance retained'
node "$tool/scripts/deploy/render-online-nginx.mjs" "$state/nginx-template.conf" "$state/$candidate_sha.conf" "$DX_ROOT/frontend/releases/$candidate_sha" "$active_port"
phase maintenance-activating
link_config "$state/$candidate_sha.conf"
if ! nginx -t || ! nginx -s reload || ! public_verify "$candidate_sha"; then
  link_config "$state/maintenance.conf"
  nginx -t && nginx -s reload
  die 'candidate activation failed after migration; maintenance retained, no old-schema rollback'
fi
worker commit-online-generation.sh "$candidate_sha"
node -e 'require("fs").writeFileSync(process.argv[1],JSON.stringify({sha:process.argv[2],port:Number(process.argv[3])})+"\n",{mode:0o600})' "$state/active.json.tmp" "$candidate_sha" "$active_port"
mv -Tf "$state/active.json.tmp" "$state/active.json"
phase completed
worker save-online-processes.sh
safe_log pass "MAINTENANCE_RELEASE_SUCCESS sha=$candidate_sha; next same-schema update uses dx-rework-update main"
