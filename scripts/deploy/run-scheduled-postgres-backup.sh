#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
umask 077

backup_root="$DX_ROOT/backups/postgres/daily"
status_root="$DX_ROOT/evidence/ops03"
success_file="$status_root/daily-backup-last-success.json"
failure_file="$status_root/daily-backup-last-failure.json"
keep_count=14
active_sha="UNKNOWN"

write_json_status() {
  local path="$1" status="$2" detail="$3" created_at tmp
  created_at="$(date -u +%FT%T.%NZ)"
  tmp="$(mktemp "$status_root/.daily-backup-status.XXXXXX")"
  node_exec - "$tmp" "$status" "$created_at" "$active_sha" "$detail" <<'JS'
const fs=require("fs");
const [path,status,createdAt,gitSha,detail]=process.argv.slice(2);
fs.writeFileSync(path,JSON.stringify({status,createdAt,gitSha,detail},null,2)+"\n",{mode:0o600});
JS
  mv -f "$tmp" "$path"
}

on_exit() {
  local rc=$?
  trap - EXIT
  if (( rc != 0 )); then
    mkdir -p "$status_root" 2>/dev/null || true
    chmod 0700 "$status_root" 2>/dev/null || true
    write_json_status "$failure_file" "failed" "exit_code=$rc" 2>/dev/null || true
  fi
  exit "$rc"
}
trap on_exit EXIT

load_app_config
load_database_tool_config
install -d -m 0700 "$backup_root" "$status_root"
acquire_lock "$DX_ROOT/locks/daily-postgres-backup.lock"

release_lock="$(assert_safe_path "$DX_ROOT/locks/release.lock")"
[[ ! -L "$release_lock" ]] || die 'release lock must not be a symlink'
exec 7>"$release_lock"
flock -w 1800 7 || die 'release lock remained busy for 30 minutes'

active_api="$(realpath "$DX_ROOT/current")"
[[ "$active_api" == "$DX_ROOT/releases/"* && -d "$active_api" && ! -L "$active_api" ]] ||
  die 'active API release path is unavailable or unsafe'
active_sha="$(basename "$active_api")"
require_sha "$active_sha"
[[ "$(manifest_field "$active_api/release-manifest.json" gitSha)" == "$active_sha" ]] ||
  die 'active release manifest SHA mismatch'

manifest="$active_api/apps/api/src/platform/migration-manifest.json"
DATABASE_URL="$DATABASE_URL" node_exec   "$active_api/scripts/deploy/database-state.mjs" verify-current "$manifest"
current_state="$(DATABASE_URL="$DATABASE_URL" node_exec   "$active_api/scripts/deploy/database-state.mjs" print-current)"
target_version="$(node_exec -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const x=m.migrations.at(-1);
if(!x)process.exit(1);
process.stdout.write(x.version);
' "$manifest")"
target_checksum="$(node_exec -e '
const fs=require("fs");
const m=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));
const x=m.migrations.at(-1);
if(!x)process.exit(1);
process.stdout.write(x.checksum);
' "$manifest")"

DX_REWORK_BACKUP_DIR="$backup_root" GIT_SHA="$active_sha" CURRENT_DATABASE_STATE="$current_state" TARGET_SCHEMA_VERSION="$target_version" TARGET_SCHEMA_CHECKSUM="$target_checksum"   "$active_api/scripts/backup-postgres.sh"

latest="$(
  find "$backup_root" -mindepth 2 -maxdepth 2 -type f -name COMPLETE -printf '%T@ %h\n' |
    sort -nr |
    head -1 |
    cut -d' ' -f2-
)"
[[ -n "$latest" && -d "$latest" && ! -L "$latest" ]] ||
  die 'scheduled backup did not produce a complete backup set'
latest="$(assert_safe_path "$latest" "$backup_root")"
(
  cd "$latest"
  sha256sum -c --strict SHA256SUMS >/dev/null
)
pg_exec pg_restore --list "$latest/database.dump" >/dev/null

node_exec - "$latest/metadata.json" "$active_sha" "$target_version" <<'JS'
const fs=require("fs");
const [path,gitSha,schemaVersion]=process.argv.slice(2);
const m=JSON.parse(fs.readFileSync(path,"utf8"));
if(m.gitSha!==gitSha||m.schemaVersion!==schemaVersion||m.targetSchemaVersion!==schemaVersion)process.exit(1);
JS

mapfile -t complete_sets < <(
  find "$backup_root" -mindepth 2 -maxdepth 2 -type f -name COMPLETE -printf '%h\n' |
    LC_ALL=C sort -r
)
pruned=0
if (( ${#complete_sets[@]} > keep_count )); then
  for stale in "${complete_sets[@]:keep_count}"; do
    stale="$(assert_safe_path "$stale" "$backup_root")"
    [[ "$stale" == "$backup_root/"* && -d "$stale" && ! -L "$stale" ]] ||
      die 'scheduled retention candidate is unsafe'
    for required in COMPLETE SHA256SUMS database.dump metadata.json; do
      [[ -f "$stale/$required" && ! -L "$stale/$required" ]] ||
        die 'scheduled retention candidate is incomplete'
    done
    rm -rf -- "$stale"
    pruned=$((pruned + 1))
  done
fi

size_bytes="$(du -sb "$latest" | awk '{print $1}')"
detail="backup_set=$latest schema=$target_version size_bytes=$size_bytes keep=$keep_count pruned=$pruned"
write_json_status "$success_file" "success" "$detail"
rm -f -- "$failure_file"
safe_log pass "scheduled_postgres_backup $detail"
