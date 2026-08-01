#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
: "${DX_REWORK_BACKUP_DIR:=/opt/dx-rework/backups/postgres}"

umask 077
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
filename="dx-rework-${timestamp}.dump"
target="${DX_REWORK_BACKUP_DIR}/${filename}"

install -d -m 0700 "${DX_REWORK_BACKUP_DIR}"
pg_dump --dbname="${DATABASE_URL}" --format=custom --no-owner --no-acl --file="${target}"
(
  cd "${DX_REWORK_BACKUP_DIR}"
  sha256sum "${filename}" > "${filename}.sha256"
)

printf '{"success":true,"backup":"%s","checksum":"%s.sha256"}\n' "${target}" "${target}"
