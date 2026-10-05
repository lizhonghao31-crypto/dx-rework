#!/usr/bin/env bash
# Stable root entry; builds and PM2 run as dxacceptance; migration SQL runs as the fixed database owner.
set -Eeuo pipefail
umask 022
export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
tool_root="$(cd "$(dirname "$0")/.." && pwd -P)"
command="${1:-help}"
case "$command" in
  install|update|diagnose) ;;
  *) echo 'Usage: dx-acceptance update [40-character SHA] | diagnose [40-character SHA] | install'; exit 64 ;;
esac
if [[ "$command" == update || "$command" == diagnose ]]; then
  [[ $# -le 2 ]] || exit 64
  [[ -z "${2:-}" || "$2" =~ ^[0-9a-f]{40}$ ]] || exit 64
fi
[[ "$(id -u)" == 0 ]] || { echo 'Run this command as root.' >&2; exit 1; }
if [[ "$command" == install ]]; then
  [[ $# == 1 ]] || exit 64
  exec 8>/run/lock/dx-acceptance-update.lock
  flock -n 8 || { echo 'Another Acceptance tool installation or update is running.' >&2; exit 1; }
  # Install an immutable, complete tool revision, independently of the app SHA.
  owner="$(stat -c %U "$tool_root")"
  tool_sha="$(runuser -u "$owner" -- git -C "$tool_root" rev-parse HEAD)"
  [[ "$tool_sha" =~ ^[0-9a-f]{40}$ ]]
  [[ -z "$(runuser -u "$owner" -- git -C "$tool_root" status --porcelain)" ]]
  tools=/opt/dx-rework-acceptance-tools
  install -d -o root -g root -m 0755 "$tools"
  staging="$(mktemp -d "$tools/.install.XXXXXX")"
  trap '[[ -z "${staging:-}" ]] || rm -rf -- "$staging"' EXIT
  runuser -u "$owner" -- git -C "$tool_root" archive "$tool_sha" | tar -x -C "$staging"
  printf '%s\n' "$tool_sha" > "$staging/TOOL_SHA"
  chown -R root:root "$staging"
  chmod -R go-w "$staging"
  chmod 0755 "$staging"
  if [[ -e "$tools/$tool_sha" ]]; then
    [[ -d "$tools/$tool_sha" && ! -L "$tools/$tool_sha" ]]
    diff -qr "$staging" "$tools/$tool_sha" >/dev/null || { echo 'Existing tool revision is incomplete or changed; entry was not replaced.' >&2; exit 1; }
    rm -rf -- "$staging"
  else
    mv "$staging" "$tools/$tool_sha"
  fi
  staging=''
  launcher="$(mktemp /usr/local/bin/.dx-acceptance.XXXXXX)"
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$tool_sha/scripts/dx-acceptance.sh" > "$launcher"
  chmod 0755 "$launcher"
  mv -Tf "$launcher" /usr/local/bin/dx-acceptance
  launcher="$(mktemp /usr/local/bin/.dx-rework-update.XXXXXX)"
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$tool_sha/scripts/dx-update.sh" > "$launcher"
  chmod 0755 "$launcher"
  mv -Tf "$launcher" /usr/local/bin/dx-rework-update
  echo 'Installed. Run: dx-acceptance update'
  exit 0
fi
[[ $# -le 2 ]] || exit 64
[[ -f "$tool_root/TOOL_SHA" && "$(stat -c %U "$tool_root")" == root ]]
[[ "$tool_root" == /opt/dx-rework-acceptance-tools/* ]]
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
trap 'rc=$?; if [[ -n "${staging:-}" && "$staging" == /opt/dx-rework-acceptance-tools/.refresh.* ]]; then rm -rf -- "$staging"; fi; if ((rc)); then echo "Acceptance update failed; evidence=$snapshot; no production deployment was performed." >&2; else rm -rf -- "$snapshot"; fi' EXIT
bash "$tool_root/scripts/deploy/fetch-update-source.sh" "$sha" "$snapshot"
if [[ "$command" == update && "$sha" != "$(cat "$tool_root/TOOL_SHA")" ]]; then
  python3 "$tool_root/scripts/deploy/verify-tool-refresh.py" "$tool_root" "$snapshot"
  # Only the immutable installed validator authorizes this data refresh.
  # A different executable policy fails before build, backup or service stop.
  tools=/opt/dx-rework-acceptance-tools
  target="$tools/$sha"
  if [[ ! -e "$target" ]]; then
    staging="$(mktemp -d "$tools/.refresh.XXXXXX")"
    cp -a "$snapshot/." "$staging/"
    printf '%s\n' "$sha" > "$staging/TOOL_SHA"
    chown -R root:root "$staging"
    chmod -R go-w "$staging"
    chmod 0755 "$staging"
    python3 "$tool_root/scripts/deploy/verify-tool-refresh.py" "$tool_root" "$staging"
    mv -T "$staging" "$target"
    staging=''
  fi
  [[ -d "$target" && ! -L "$target" && "$(stat -c %U "$target")" == root ]]
  [[ "$(cat "$target/TOOL_SHA")" == "$sha" ]]
  python3 "$tool_root/scripts/deploy/verify-tool-refresh.py" "$tool_root" "$target"
  cmp "$snapshot/apps/api/src/platform/migration-manifest.json" "$target/apps/api/src/platform/migration-manifest.json"
  cmp "$snapshot/scripts/migration-main-extensions.json" "$target/scripts/migration-main-extensions.json"
  launcher="$(mktemp /usr/local/bin/.dx-acceptance.XXXXXX)"
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$target/scripts/dx-acceptance.sh" > "$launcher"
  chmod 0755 "$launcher"
  mv -Tf "$launcher" /usr/local/bin/dx-acceptance
  tool_root="$target"
  echo "ACCEPTANCE_TOOL_REFRESH_OK sha=$sha"
fi
printf 'Tool: %s\n' "$(cat "$tool_root/TOOL_SHA")"
if [[ "$command" == diagnose ]]; then
  # Read-only database inspection, no candidate build, backup, PM2 or migration.
  [[ -f "$root/locks/release.lock" && ! -L "$root/locks/release.lock" ]]
  exec 9>"$root/locks/release.lock"
  flock -n 9 || { echo 'Acceptance release lock is held.' >&2; exit 1; }
  install -o dxacceptance -g dxacceptance -m 0600 /dev/null "$snapshot/acceptance-identity.json"
  runuser -u dxacceptance -- env -i HOME=/home/dxacceptance USER=dxacceptance PATH="$PATH" \
    bash "$tool_root/scripts/deploy/inspect-acceptance-identity.sh" "$snapshot" "$tool_root"
  bash "$tool_root/scripts/deploy/run-acceptance-maintenance.sh" "$snapshot" preflight
  echo "ACCEPTANCE_DIAGNOSTICS_FINISHED sha=$sha"
  exit 0
fi
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
  bash "$tool_root/scripts/deploy/export-production-history.sh" > "$snapshot/production-history.json"
chown dxacceptance:dxacceptance "$snapshot/production-history.json"
chmod 0600 "$snapshot/production-history.json"
install -o dxacceptance -g dxacceptance -m 0600 /dev/null "$snapshot/acceptance-identity.json"
install -o dxacceptance -g dxacceptance -m 0600 /dev/null "$snapshot/worker-evidence"
[[ -f "$root/locks/release.lock" && ! -L "$root/locks/release.lock" ]]
exec 9>"$root/locks/release.lock"
flock -n 9 || { echo 'Acceptance release lock is held.' >&2; exit 1; }
worker() {
  runuser -u dxacceptance -- env -i HOME=/home/dxacceptance USER=dxacceptance PATH="$PATH" DX_REWORK_LOCK_FD=9 \
    bash "$tool_root/scripts/deploy/update-acceptance-local.sh" "$sha" "$snapshot" "$1" "$tool_root"
}
maintenance() {
  bash "$tool_root/scripts/deploy/run-acceptance-maintenance.sh" "$snapshot" "$1"
}
source "$tool_root/scripts/deploy/acceptance-update-flow.sh"
acceptance_update_flow
curl --max-time 15 -fsS http://127.0.0.1:3201/health/ready >/dev/null
echo "ACCEPTANCE_UPDATE_FINISHED sha=$sha production_3201=ready"
