#!/usr/bin/env bash
# Stable root entry; builds and PM2 run as dxacceptance; migration SQL runs as the fixed database owner.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
command="${1:-help}"
case "$command" in
  install|update) ;;
  *) echo 'Usage: dx-acceptance update [40-character SHA] | install'; exit 64 ;;
esac
[[ "$(id -u)" == 0 ]] || { echo 'Run this command as root.' >&2; exit 1; }
if [[ "$command" == install ]]; then
  [[ $# == 1 ]] || exit 64
  install -o root -g root -m 0755 "$(realpath "$0")" /usr/local/bin/dx-acceptance
  echo 'Installed. Run: dx-acceptance update'
  exit 0
fi
[[ $# -le 2 ]] || exit 64
requested="${2:-}"
[[ -z "$requested" || "$requested" =~ ^[0-9a-f]{40}$ ]] || exit 64
src=/opt/dx-rework/source
root=/opt/dx-rework-acceptance
[[ -d "$src/.git" && -d "$root/shared" && ! -L "$root" ]]
exec 8>/run/lock/dx-acceptance-update.lock
flock -n 8 || { echo 'Another Acceptance update is running.' >&2; exit 1; }
git_source() { runuser -u dxrework -- git -C "$src" "$@"; }
origin="$(git_source remote get-url origin)"
[[ "$origin" == git@github.com:lizhonghao31-crypto/dx-rework.git || "$origin" == https://github.com/lizhonghao31-crypto/dx-rework.git ]]
curl --max-time 15 -fsS http://127.0.0.1:3201/health/ready >/dev/null
nginx -t
git_source fetch --quiet origin refs/heads/release/digital-production-v1:refs/remotes/origin/release/digital-production-v1
sha="${requested:-$(git_source rev-parse refs/remotes/origin/release/digital-production-v1)}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
git_source merge-base --is-ancestor "$sha" refs/remotes/origin/release/digital-production-v1
snapshot="$(mktemp -d /tmp/dx-acceptance-source.XXXXXX)"
chmod 0755 "$snapshot"
trap 'rc=$?; rm -rf -- "$snapshot"; if ((rc)); then echo "Acceptance update failed; no production deployment was performed." >&2; fi' EXIT
git_source archive "$sha" | tar -x -C "$snapshot"
[[ -f "$snapshot/scripts/deploy/update-acceptance-local.sh" ]]
previous="$(python3 - "$root/current/release-manifest.json" "$root/frontend/current/release-manifest.json" <<'PY'
import json,sys
api,web=[json.load(open(p)) for p in sys.argv[1:]]
if api['gitSha']!=web['gitSha']: raise SystemExit('Current API/frontend versions disagree')
print(api['gitSha'])
PY
)"
if [[ "$previous" =~ ^[0-9a-f]{40}$ ]] && git_source cat-file -e "$previous^{commit}" 2>/dev/null; then
  git_source diff --name-only "$previous" "$sha" > "$snapshot/changed-paths.txt"
else
  printf '__full_build__\n' > "$snapshot/changed-paths.txt"
fi
echo "Candidate: $sha"
# The exporter remains root-owned. Production credentials never enter the Acceptance worker.
runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$PATH" \
  bash "$snapshot/scripts/deploy/export-production-history.sh" > "$snapshot/production-history.json"
chown dxacceptance:dxacceptance "$snapshot/production-history.json"
chmod 0600 "$snapshot/production-history.json"
install -o dxacceptance -g dxacceptance -m 0600 /dev/null "$snapshot/acceptance-identity.json"
[[ -f "$root/locks/release.lock" && ! -L "$root/locks/release.lock" ]]
exec 9>"$root/locks/release.lock"
flock -n 9 || { echo 'Acceptance release lock is held.' >&2; exit 1; }
worker() {
  runuser -u dxacceptance -- env -i HOME=/home/dxacceptance USER=dxacceptance PATH="$PATH" DX_REWORK_LOCK_FD=9 \
    bash "$snapshot/scripts/deploy/update-acceptance-local.sh" "$sha" "$snapshot" "$1"
}
prepare_rc=0
worker prepare || prepare_rc=$?
if [[ "$prepare_rc" != 10 ]]; then
  [[ "$prepare_rc" == 0 ]] || exit "$prepare_rc"
  bash "$snapshot/scripts/deploy/run-acceptance-maintenance.sh" "$snapshot"
  worker activate
fi
curl --max-time 15 -fsS http://127.0.0.1:3201/health/ready >/dev/null
echo "ACCEPTANCE_UPDATE_FINISHED sha=$sha production_3201=ready"
