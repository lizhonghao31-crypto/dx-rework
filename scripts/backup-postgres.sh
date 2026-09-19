#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/deploy/lib.sh"
umask 077

# Always validate the real target files; do not trust a caller-supplied boolean
# claiming configuration has already been loaded.
load_app_config
load_node_config

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${GIT_SHA:?GIT_SHA is required}"
: "${CURRENT_DATABASE_STATE:?CURRENT_DATABASE_STATE is required}"
: "${TARGET_SCHEMA_VERSION:?TARGET_SCHEMA_VERSION required}"
: "${TARGET_SCHEMA_CHECKSUM:?TARGET_SCHEMA_CHECKSUM required}"
require_sha "$GIT_SHA"

readarray -t db_schema < <(
  node_exec -e '
const x=JSON.parse(process.argv[1]);
if(typeof x.count!=="number")process.exit(1);
console.log(x.version??"UNINITIALIZED");
console.log(x.checksum??"UNINITIALIZED");
' "$CURRENT_DATABASE_STATE"
)

root="$(assert_safe_path "${DX_REWORK_BACKUP_DIR:-$DX_ROOT/backups/postgres}")"
install -d -m 0700 "$root"
exec 8>"$root/.backup.lock"
flock -n 8 || die 'backup lock is held'

fingerprint="$(database_connection_fingerprint "$DATABASE_URL")"

stamp="$(date -u +%Y%m%dT%H%M%S.%NZ)"
name="${stamp}-${GIT_SHA:0:12}-$(od -An -N6 -tx1 /dev/urandom | tr -d ' \n')"
tmp="$root/.tmp-$name"
final="$root/$name"
[[ ! -e "$final" ]] || die 'backup set already exists'
mkdir -m 0700 "$tmp"
trap 'rm -rf -- "$tmp"' EXIT

pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$tmp/database.dump"
pg_restore --list "$tmp/database.dump" >/dev/null

node_exec - "$tmp/metadata.json" "$GIT_SHA" "${db_schema[0]}" "${db_schema[1]}" \
  "$TARGET_SCHEMA_VERSION" "$TARGET_SCHEMA_CHECKSUM" "$fingerprint" "$(date -u +%FT%T.%NZ)" <<'JS'
const fs=require('fs');
const [p,gitSha,schemaVersion,schemaChecksum,targetSchemaVersion,targetSchemaChecksum,sourceFingerprint,createdAt]=process.argv.slice(2);
fs.writeFileSync(p,JSON.stringify({formatVersion:2,gitSha,schemaVersion,schemaChecksum,targetSchemaVersion,targetSchemaChecksum,sourceFingerprint,createdAt},null,2)+'\n',{mode:0o600});
JS

(
  cd "$tmp"
  sha256sum database.dump metadata.json > SHA256SUMS
  [[ "$(wc -l < SHA256SUMS)" == 2 ]]
  sha256sum -c --strict SHA256SUMS >/dev/null
)
: > "$tmp/COMPLETE"
mv "$tmp" "$final"
trap - EXIT
safe_log pass "backup_set=$final schema=${db_schema[0]} target_schema=$TARGET_SCHEMA_VERSION"
