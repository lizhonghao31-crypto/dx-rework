#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/deploy/lib.sh"

load_node_config
load_restore_config

[[ $# == 1 ]] || die 'usage: restore-postgres.sh BACKUP_SET'
setdir="$(assert_safe_path "$1" "${DX_REWORK_BACKUP_DIR:-$DX_ROOT/backups/postgres}")"
[[ -d "$setdir" && ! -L "$setdir" && -f "$setdir/COMPLETE" ]] || die 'incomplete backup set'
[[ "${DX_REWORK_RESTORE_DRILL:-false}" == true && \
   "${DX_REWORK_RESTORE_CONFIRM:-}" == RESTORE_TO_ISOLATED_DRILL ]] ||
  die 'restore drill confirmation missing'

: "${DX_REWORK_RESTORE_DATABASE_URL:?target database required}"
: "${DX_REWORK_APPROVED_TARGET_FINGERPRINT:?approved target fingerprint required}"
: "${DX_REWORK_APPROVED_TARGET_DATABASE:?approved target database required}"

[[ "$(cat "$setdir/SHA256SUMS")" =~ ^[0-9a-f]{64}\ \ database.dump$'\n'[0-9a-f]{64}\ \ metadata.json$ ]] ||
  die 'checksum manifest must contain exactly safe basenames'
(cd "$setdir" && sha256sum -c --strict SHA256SUMS >/dev/null) ||
  die 'backup metadata or dump checksum damaged'

meta="$(cat "$setdir/metadata.json")"
node_exec -e '
const m=JSON.parse(process.argv[1]);
for(const k of ["createdAt","gitSha","schemaVersion","schemaChecksum","sourceFingerprint"]){
  if(typeof m[k]!=="string"||!m[k])process.exit(1);
}
if(!Number.isFinite(Date.parse(m.createdAt)))process.exit(1);
' "$meta" || die 'invalid metadata'

db_identity() {
  psql "$1" -XAtqc "select coalesce(inet_server_addr()::text,'local')||':'||inet_server_port()||'/'||current_database()"
}
target_identity="$(db_identity "$DX_REWORK_RESTORE_DATABASE_URL")"
target_name="${target_identity##*/}"
target_fp="$(printf %s "$target_identity" | sha256sum | cut -d' ' -f1)"
metadata_fp="$(node_exec -e 'process.stdout.write(JSON.parse(process.argv[1]).sourceFingerprint)' "$meta")"
[[ "$target_fp" != "$metadata_fp" ]] || die 'source/target stable database identity rejected'
[[ "$target_name" =~ ^dx_rework_(drill|restore)_[a-z0-9_]+$ && \
   "$target_name" == "$DX_REWORK_APPROVED_TARGET_DATABASE" && \
   "$target_fp" == "$DX_REWORK_APPROVED_TARGET_FINGERPRINT" ]] ||
  die 'target is not the explicitly approved drill database'

user_object_count="$(psql "$DX_REWORK_RESTORE_DATABASE_URL" -XAtqc "
  select count(*)
  from pg_class c
  join pg_namespace n on n.oid=c.relnamespace
  where n.nspname <> 'information_schema'
    and n.nspname not like 'pg_%'
    and c.relkind in ('r','p','v','m','S','f')
")"
[[ "$user_object_count" == 0 ]] || die 'target contains user objects'

pg_restore --list "$setdir/database.dump" >/dev/null
start="$(date +%s)"
pg_restore --single-transaction --exit-on-error --no-owner --no-acl \
  --dbname="$DX_REWORK_RESTORE_DATABASE_URL" "$setdir/database.dump"

manifest="${DX_REWORK_RESTORE_MANIFEST:?restored release migration manifest required}"
expected_version="$(node_exec -e 'process.stdout.write(JSON.parse(process.argv[1]).schemaVersion)' "$meta")"
expected_checksum="$(node_exec -e 'process.stdout.write(JSON.parse(process.argv[1]).schemaChecksum)' "$meta")"
[[ "$expected_version" != UNINITIALIZED ]] ||
  die 'uninitialized backup requires a dedicated bootstrap restore procedure'
node_exec -e '
const fs=require("fs"),m=JSON.parse(fs.readFileSync(process.argv[1])),x=m.migrations.at(-1);
if(!x||x.version!==process.argv[2]||x.checksum!==process.argv[3])process.exit(1);
' "$manifest" "$expected_version" "$expected_checksum" ||
  die 'restore manifest is not checksum-bound to backup schema'

DATABASE_URL="$DX_REWORK_RESTORE_DATABASE_URL" node_exec \
  "$(dirname "$0")/deploy/database-state.mjs" verify-current "$manifest"
DATABASE_URL="$DX_REWORK_RESTORE_DATABASE_URL" node_exec \
  "$(dirname "$0")/deploy/verify-database-readiness.mjs" "$manifest"

created="$(node_exec -e 'process.stdout.write(String(Math.floor(Date.parse(JSON.parse(process.argv[1]).createdAt)/1000)))' "$meta")"
now="$(date +%s)"
safe_log pass "restore_drill target=$target_fp rpo_seconds=$((now-created)) rto_seconds=$((now-start))"
