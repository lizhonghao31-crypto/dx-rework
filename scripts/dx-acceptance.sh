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
if [[ "$command" == update || "$command" == diagnose || "$command" == install ]]; then
  [[ $# -le 2 ]] || exit 64
  [[ -z "${2:-}" || "$2" =~ ^[0-9a-f]{40}$ ]] || exit 64
fi
[[ "$(id -u)" == 0 ]] || { echo 'Run this command as root.' >&2; exit 1; }
# The same lock used by main updates pins production throughout installation/update.
# Open read-only: this controller never changes production lock data or generations.
production_lock=/opt/dx-rework/locks/release.lock
[[ -f "$production_lock" && ! -L "$production_lock" ]] || { echo 'Production release lock is unavailable.' >&2; exit 1; }
exec 7<"$production_lock"
flock -n 7 || { echo 'Production release work is in progress; Acceptance was not changed.' >&2; exit 1; }
if [[ "$command" == install ]]; then
  [[ $# == 1 || $# == 2 ]] || exit 64
  exec 8>/run/lock/dx-acceptance-update.lock
  flock -n 8 || { echo 'Another Acceptance tool installation or update is running.' >&2; exit 1; }
  # Install an immutable, complete tool revision, independently of the app SHA.
  owner="$(stat -c %U "$tool_root")"
  tool_sha="$(runuser -u "$owner" -- git -C "$tool_root" rev-parse HEAD)"
  [[ "$tool_sha" =~ ^[0-9a-f]{40}$ ]]
  [[ -z "${2:-}" || "$2" == "$tool_sha" ]] || { echo 'Expected tool SHA does not match the clean checkout.' >&2; exit 1; }
  [[ -z "$(runuser -u "$owner" -- git -C "$tool_root" status --porcelain)" ]]
  python3 "$tool_root/scripts/deploy/acceptance-capacity.py" install "$tool_root" "$tool_root" "$tool_sha"
  tools=/opt/dx-rework-acceptance-tools
  install -d -o root -g root -m 0755 "$tools"
  staging="$(mktemp -d "$tools/.install.XXXXXX")"
  entry_backup=''
  entry_changes=false
  cleanup_install() {
    local rc=$? name restored rollback_failed=false
    if (( rc )) && [[ "$entry_changes" == true && -n "$entry_backup" ]]; then
      for name in dx-acceptance dx-rework-update; do
        if [[ -f "$entry_backup/$name" ]]; then
          restored="$(mktemp "/usr/local/bin/.$name.restore.XXXXXX")" || { rollback_failed=true; continue; }
          if install -m 0755 "$entry_backup/$name" "$restored" && mv -Tf "$restored" "/usr/local/bin/$name"; then :; else rollback_failed=true; fi
        elif [[ -f "$entry_backup/$name.absent" ]]; then
          rm -f -- "/usr/local/bin/$name" || rollback_failed=true
        fi
      done
      if [[ "$rollback_failed" == true ]]; then
        echo "ENTRY_ROLLBACK_REQUIRED backup=$entry_backup; no production launcher was changed." >&2
      else
        echo "ENTRY_INSTALL_FAILED_ROLLED_BACK backup=$entry_backup" >&2
      fi
    fi
    [[ -z "${staging:-}" ]] || rm -rf -- "$staging"
    return "$rc"
  }
  trap cleanup_install EXIT
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
  entry_backup="$(mktemp -d "$tools/.entry-backup-$tool_sha.XXXXXX")"
  chmod 0700 "$entry_backup"
  for name in dx-acceptance dx-rework-update; do
    existing="/usr/local/bin/$name"
    [[ ! -L "$existing" ]] || { echo 'Unsafe existing Acceptance entry; installation refused.' >&2; exit 1; }
    if [[ -e "$existing" ]]; then
      [[ -f "$existing" && "$(stat -c %U "$existing")" == root && "$(stat -c %a "$existing")" == 755 ]] || { echo 'Unsafe existing Acceptance entry; installation refused.' >&2; exit 1; }
      cp -p -- "$existing" "$entry_backup/$name"
    else
      printf 'absent\n' > "$entry_backup/$name.absent"
    fi
  done
  entry_changes=true
  launcher="$(mktemp /usr/local/bin/.dx-acceptance.XXXXXX)"
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$tool_sha/scripts/dx-acceptance.sh" > "$launcher"
  chmod 0755 "$launcher"
  mv -Tf "$launcher" /usr/local/bin/dx-acceptance
  launcher="$(mktemp /usr/local/bin/.dx-rework-update.XXXXXX)"
  printf '#!/usr/bin/env bash\nexec bash %q "$@"\n' "$tools/$tool_sha/scripts/dx-update.sh" > "$launcher"
  chmod 0755 "$launcher"
  mv -Tf "$launcher" /usr/local/bin/dx-rework-update
  entry_changes=false
  echo "ACCEPTANCE_ENTRY_BACKUP=$entry_backup"
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
production_guard="$(python3 "$tool_root/scripts/deploy/production-runtime-health.py" check)"
nginx -t
snapshot="$(mktemp -d /tmp/dx-acceptance-source.XXXXXX)"
chmod 0755 "$snapshot"
cleanup_update() {
  local rc=$?
  if [[ -n "${staging:-}" && "$staging" == /opt/dx-rework-acceptance-tools/.refresh.* ]]; then rm -rf -- "$staging"; fi
  if ((rc)); then
    python3 "$tool_root/scripts/deploy/cleanup-update-source.py" "$snapshot" || true
    echo "Acceptance update failed; evidence=$snapshot; no production deployment was performed." >&2
  else
    rm -rf -- "$snapshot"
  fi
  return "$rc"
}
trap cleanup_update EXIT
metadata="$snapshot/.acceptance-preflight"
mkdir -m 0755 "$metadata"
capacity_check() {
  local phase="$1" target_sha="$2" identity="$metadata/identity-$1.json" input="$metadata/identity-$1-input.json" source_dir="$snapshot" storage=() ledger=()
  [[ "$phase" == *download ]] && source_dir="$src"
  install -o dxacceptance -g dxacceptance -m 0600 /dev/null "$input"
  runuser -u dxacceptance -- env -i HOME=/home/dxacceptance USER=dxacceptance PATH="$PATH" \
    bash "$tool_root/scripts/deploy/inspect-acceptance-identity.sh" "$snapshot" "$tool_root" "$phase-input" || return $?
  install -o root -g root -m 0444 "$input" "$identity"
  rm -f -- "$input"
  if [[ "$command" == update ]]; then
    case "$phase" in build|backup|stop) ledger=(--with-history);; esac
    python3 "$tool_root/scripts/deploy/inspect-acceptance-storage.py" "$identity" "$metadata/storage-$phase.json" "${ledger[@]}" || return $?
    storage=(--storage "$metadata/storage-$phase.json")
  else
    python3 "$tool_root/scripts/deploy/inspect-acceptance-storage.py" "$identity" --validate-only || return $?
  fi
  if [[ -e "$metadata/identity-first.json" ]]; then
    cmp -s "$metadata/identity-first.json" "$identity" || { echo 'Acceptance database identity changed during update.' >&2; return 1; }
  else
    cp "$identity" "$metadata/identity-first.json"
  fi
  python3 "$tool_root/scripts/deploy/acceptance-capacity.py" "$phase" "$source_dir" "$tool_root" "$target_sha" "${storage[@]}" | tee "$metadata/capacity-$phase.json"
}
if [[ "$command" == update ]]; then capacity_check download "${requested:--}"; else capacity_check diagnose-download "${requested:--}"; fi
git_source fetch --quiet origin refs/heads/release/digital-production-v1:refs/remotes/origin/release/digital-production-v1
sha="${requested:-$(git_source rev-parse refs/remotes/origin/release/digital-production-v1)}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
git_source merge-base --is-ancestor "$sha" refs/remotes/origin/release/digital-production-v1
bash "$tool_root/scripts/deploy/fetch-update-source.sh" "$sha" "$snapshot" "$command"
cp "$metadata/identity-first.json" "$snapshot/acceptance-identity.json"
chmod 0444 "$snapshot/acceptance-identity.json"
if [[ "$command" == update && "$sha" != "$(cat "$tool_root/TOOL_SHA")" ]]; then
  python3 "$tool_root/scripts/deploy/verify-tool-refresh.py" "$tool_root" "$snapshot"
  # Only the immutable installed validator authorizes this data refresh.
  # A different executable policy fails before build, backup or service stop.
  tools=/opt/dx-rework-acceptance-tools
  target="$tools/$sha"
  if [[ ! -e "$target" ]]; then
    staging="$(mktemp -d "$tools/.refresh.XXXXXX")"
    cp -a "$snapshot/." "$staging/"
    rm -rf -- "$staging/.acceptance-preflight"
    rm -f -- "$staging/acceptance-identity.json"
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
# MAIN_RELEASE_COMPAT_START: source-only; before DB export, build, backup or stop.
if ! runuser -u dxrework -- env -i HOME=/home/dxrework USER=dxrework PATH="$PATH" \
  bash -c '
    set -euo pipefail
    source "$1/scripts/deploy/lib.sh"
    load_node_config
    node_exec "$1/scripts/check-main-release-compat.mjs" --intent acceptance --repo "$2" --candidate-ref "$3" --tool-ref "$4"
  ' _ "$tool_root" "$src" "$sha" "$(cat "$tool_root/TOOL_SHA")" > "$snapshot/main-release-compat.json"; then
  cat "$snapshot/main-release-compat.json" >&2
  exit 1
fi
cat "$snapshot/main-release-compat.json"
# MAIN_RELEASE_COMPAT_END
# Root-owned, immutable identity shared with the unprivileged verifier.
printf '%s\n' "$production_guard" > "$snapshot/production-runtime.json"
chmod 0444 "$snapshot/production-runtime.json"
printf 'Tool: %s\n' "$(cat "$tool_root/TOOL_SHA")"
if [[ "$command" == diagnose ]]; then
  # Read-only database inspection, no candidate build, backup, PM2 or migration.
  [[ -f "$root/locks/release.lock" && ! -L "$root/locks/release.lock" ]]
  exec 9>"$root/locks/release.lock"
  flock -n 9 || { echo 'Acceptance release lock is held.' >&2; exit 1; }
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
# Independent Acceptance updates validate their own live ledger in the trusted worker.
# Production migration compatibility is a required production-promotion check.
install -o dxacceptance -g dxacceptance -m 0600 /dev/null "$snapshot/worker-evidence"
[[ -f "$root/locks/release.lock" && ! -L "$root/locks/release.lock" ]]
exec 9>"$root/locks/release.lock"
flock -n 9 || { echo 'Acceptance release lock is held.' >&2; exit 1; }
worker() {
  case "$1" in
    prepare) capacity_check build "$sha" || return $?;;
    backup) capacity_check backup "$sha" || return $?;;
    stop) capacity_check stop "$sha" || return $?;;
  esac
  runuser -u dxacceptance -- env -i HOME=/home/dxacceptance USER=dxacceptance PATH="$PATH" DX_REWORK_LOCK_FD=9 \
    bash "$tool_root/scripts/deploy/update-acceptance-local.sh" "$sha" "$snapshot" "$1" "$tool_root" 7<&-
}
maintenance() {
  bash "$tool_root/scripts/deploy/run-acceptance-maintenance.sh" "$snapshot" "$1" 7<&-
}
source "$tool_root/scripts/deploy/acceptance-update-flow.sh"
# Both update and release locks are held. Collection never credits hypothetical
# free space: the following capacity probe measures only actual reclaimed bytes.
if ! python3 "$tool_root/scripts/deploy/cleanup-acceptance-builds.py" | tee "$metadata/build-collection-before.json"; then
  echo 'Build collection incomplete; capacity check uses actual remaining free space.' >&2
fi
acceptance_update_flow
if ! python3 "$tool_root/scripts/deploy/cleanup-acceptance-builds.py" | tee "$metadata/build-collection-after.json"; then
  echo 'Build collection incomplete; installed runtime and backup retention are unchanged.' >&2
fi
production_after="$(python3 "$tool_root/scripts/deploy/production-runtime-health.py" check)"
[[ "$production_after" == "$production_guard" ]] || { echo 'Production identity changed; Acceptance update verification failed.' >&2; exit 1; }
echo "ACCEPTANCE_UPDATE_FINISHED sha=$sha production_ready=$production_after"
