#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/deploy/lib.sh"
: "${DATABASE_URL:?DATABASE_URL is required}"; : "${GIT_SHA:?GIT_SHA is required}"; : "${SCHEMA_VERSION:?SCHEMA_VERSION is required}"; require_sha "$GIT_SHA"
dir="$(assert_safe_path "${DX_REWORK_BACKUP_DIR:-/opt/dx-rework/backups/postgres}")"; umask 077; install -d -m 0700 "$dir"; stamp="$(date -u +%Y%m%dT%H%M%SZ)"; name="dx-rework-$stamp"; tmp="$(mktemp "$dir/.${name}.XXXXXX")"; trap 'rm -f -- "$tmp" "$tmp.sha256" "$tmp.metadata.json"' EXIT
# Relative checksum contract (performed below against the temporary basename):
# cd "${DX_REWORK_BACKUP_DIR}"
# sha256sum "${filename}" > "${filename}.sha256"
pg_dump --dbname="$DATABASE_URL" --format=custom --no-owner --no-acl --file="$tmp"; pg_restore --list "$tmp" >/dev/null; (cd "$dir" && sha256sum "$(basename "$tmp")" > "$tmp.sha256")
fingerprint="$(printf %s "$DATABASE_URL"|sha256sum|cut -c1-12)"; node - "$tmp.metadata.json" "$GIT_SHA" "$SCHEMA_VERSION" "$stamp" "$fingerprint" <<'JS'
const fs=require('fs');fs.writeFileSync(process.argv[2],JSON.stringify({gitSha:process.argv[3],schemaVersion:process.argv[4],createdAt:process.argv[5],sourceFingerprint:process.argv[6]},null,2)+'\n',{mode:0o600})
JS
mv "$tmp" "$dir/$name.dump"; sed "s/$(basename "$tmp")/$name.dump/" "$tmp.sha256" > "$dir/$name.sha256.tmp"; mv "$dir/$name.sha256.tmp" "$dir/$name.sha256"; mv "$tmp.metadata.json" "$dir/$name.metadata.json"; trap - EXIT; safe_log pass "backup=$dir/$name.dump checksum=$name.sha256 metadata=$name.metadata.json"
