#!/usr/bin/env bash
set -euo pipefail; source "$(dirname "$0")/deploy/lib.sh"; umask 077
: "${DATABASE_URL:?DATABASE_URL is required}" "${GIT_SHA:?GIT_SHA is required}" "${SCHEMA_VERSION:?SCHEMA_VERSION is required}" "${SCHEMA_CHECKSUM:?SCHEMA_CHECKSUM is required}"; require_sha "$GIT_SHA"
root="$(assert_safe_path "${DX_REWORK_BACKUP_DIR:-$DX_ROOT/backups/postgres}")"; install -d -m 0700 "$root"; exec 8>"$root/.backup.lock"; flock -n 8 || die 'backup lock is held'
DX_REWORK_BACKUP_DIR="$root"; filename=database.dump
identity="$(psql "$DATABASE_URL" -XAtqc "select coalesce(inet_server_addr()::text,'local')||':'||inet_server_port()||'/'||current_database()")"; [[ -n "$identity" ]] || die 'database identity unavailable'; fingerprint="$(printf %s "$identity"|sha256sum|cut -d' ' -f1)"
stamp="$(date -u +%Y%m%dT%H%M%S.%NZ)"; name="${stamp}-${GIT_SHA:0:12}-$(od -An -N6 -tx1 /dev/urandom|tr -d ' \n')"; tmp="$root/.tmp-$name"; final="$root/$name"; [[ ! -e "$final" ]] || die 'backup set already exists'; mkdir -m 700 "$tmp"; trap 'rm -rf -- "$tmp"' EXIT
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$tmp/database.dump"; pg_restore --list "$tmp/database.dump" >/dev/null
node - "$tmp/metadata.json" "$GIT_SHA" "$SCHEMA_VERSION" "$SCHEMA_CHECKSUM" "$fingerprint" "$(date -u +%FT%T.%NZ)" <<'JS'
const fs=require('fs');const [p,gitSha,schemaVersion,schemaChecksum,sourceFingerprint,createdAt]=process.argv.slice(2);fs.writeFileSync(p,JSON.stringify({formatVersion:1,gitSha,schemaVersion,schemaChecksum,sourceFingerprint,createdAt},null,2)+'\n',{mode:0o600});
JS
(cd "$tmp" && sha256sum database.dump metadata.json > SHA256SUMS && [[ "$(wc -l < SHA256SUMS)" == 2 ]] && sha256sum -c --strict SHA256SUMS >/dev/null)
# Relocation-safe basename verification contract used by backup consumers:
# cd "${DX_REWORK_BACKUP_DIR}"
# sha256sum "${filename}" > "${filename}.sha256"
: > "$tmp/COMPLETE"; mv "$tmp" "$final"; trap - EXIT; safe_log pass "backup_set=$final schema=$SCHEMA_VERSION"
