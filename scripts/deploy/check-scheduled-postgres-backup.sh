#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/lib.sh"
umask 077

backup_root="$DX_ROOT/backups/postgres/daily"
status_root="$DX_ROOT/evidence/ops03"
success_file="$status_root/daily-backup-last-success.json"
failure_file="$status_root/daily-backup-last-failure.json"
max_age_seconds=108000

load_database_tool_config
[[ -f "$success_file" && ! -L "$success_file" ]] ||
  die 'scheduled backup has no success evidence'

readarray -t status_values < <(
  node_exec - "$success_file" "$max_age_seconds" <<'JS'
const fs=require("fs");
const [path,maxAgeRaw]=process.argv.slice(2);
const x=JSON.parse(fs.readFileSync(path,"utf8"));
const created=Date.parse(x.createdAt);
const maxAge=Number(maxAgeRaw);
if(x.status!=="success"||!Number.isFinite(created)||!Number.isFinite(maxAge))process.exit(1);
const age=Math.floor((Date.now()-created)/1000);
if(age<0||age>maxAge)process.exit(2);
const match=String(x.detail||"").match(/(?:^| )backup_set=([^ ]+)/);
if(!match)process.exit(3);
console.log(match[1]);
console.log(age);
JS
)
backup_set="${status_values[0]:-}"
age_seconds="${status_values[1]:-}"
[[ -n "$backup_set" && "$age_seconds" =~ ^[0-9]+$ ]] ||
  die 'scheduled backup success evidence is invalid'

backup_set="$(assert_safe_path "$backup_set" "$backup_root")"
[[ -d "$backup_set" && ! -L "$backup_set" && -f "$backup_set/COMPLETE" ]] ||
  die 'scheduled backup set is missing or incomplete'
(
  cd "$backup_set"
  sha256sum -c --strict SHA256SUMS >/dev/null
)
pg_exec pg_restore --list "$backup_set/database.dump" >/dev/null

if [[ -f "$failure_file" && ! -L "$failure_file" && "$failure_file" -nt "$success_file" ]]; then
  die 'scheduled backup has a newer unresolved failure'
fi

safe_log pass "scheduled_postgres_backup_health backup_set=$backup_set age_seconds=$age_seconds"
