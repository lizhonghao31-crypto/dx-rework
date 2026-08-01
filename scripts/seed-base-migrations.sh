#!/usr/bin/env bash
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

manifest_path="apps/api/src/platform/migration-manifest.json"
if ! git cat-file -e "${BASE_SHA}:${manifest_path}" 2>/dev/null; then
  printf '{"success":true,"baseSha":"%s","seeded":false,"reason":"no base migration manifest"}\n' "${BASE_SHA}"
  exit 0
fi

base_dir="$(mktemp -d)"
trap 'rm -rf -- "${base_dir}"' EXIT

git archive "${BASE_SHA}" apps/api/migrations "${manifest_path}" | tar -x -C "${base_dir}"
DX_REWORK_MIGRATIONS_DIR="${base_dir}/apps/api/migrations" \
DX_REWORK_MIGRATION_MANIFEST="${base_dir}/${manifest_path}" \
node scripts/migrate.mjs

printf '{"success":true,"baseSha":"%s","seeded":true}\n' "${BASE_SHA}"
