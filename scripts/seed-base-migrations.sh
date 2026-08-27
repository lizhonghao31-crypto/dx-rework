#!/usr/bin/env bash
set -euo pipefail

: "${BASE_SHA:?BASE_SHA is required}"
: "${DATABASE_URL:?DATABASE_URL is required}"

head_sha="${HEAD_SHA:-$(git rev-parse HEAD)}"
manifest_path="apps/api/src/platform/migration-manifest.json"
if ! git cat-file -e "${BASE_SHA}:${manifest_path}" 2>/dev/null; then
  printf '{"success":true,"baseSha":"%s","seeded":false,"reason":"no base migration manifest"}\n' "${BASE_SHA}"
  exit 0
fi

base_dir="$(mktemp -d)"
trap 'rm -rf -- "${base_dir}"' EXIT

git archive "${BASE_SHA}" apps/api/migrations "${manifest_path}" | tar -x -C "${base_dir}"

mapfile -t rewritten_base_migrations < <(
  git diff --name-only --diff-filter=M "${BASE_SHA}" "${head_sha}" -- 'apps/api/migrations/*.sql' \
    | sed -nE 's#^apps/api/migrations/([0-9]{4}_[a-z0-9_]+)\.sql$#\1#p'
)

if (( ${#rewritten_base_migrations[@]} > 0 )); then
  printf -v rewritten_list '%s\n' "${rewritten_base_migrations[@]}"
  DX_REWORK_BASE_DIR="${base_dir}" \
  DX_REWORK_BASE_MANIFEST="${base_dir}/${manifest_path}" \
  DX_REWORK_REWRITTEN_BASE_MIGRATIONS="${rewritten_list}" \
  node --input-type=module <<'NODE'
import { readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const baseDir = process.env.DX_REWORK_BASE_DIR;
const manifestPath = process.env.DX_REWORK_BASE_MANIFEST;
const rewritten = new Set(
  (process.env.DX_REWORK_REWRITTEN_BASE_MIGRATIONS ?? "")
    .split("\n")
    .filter(Boolean),
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const replayFrom = manifest.migrations.findIndex((entry) => rewritten.has(entry.version));

if (replayFrom < 0) {
  throw new Error("Modified base migration is absent from the base manifest");
}

const replay = manifest.migrations.splice(replayFrom);
for (const entry of replay) {
  if (!/^\d{4}_[a-z0-9_]+$/.test(entry.version)) {
    throw new Error(`Invalid migration version in base manifest: ${entry.version}`);
  }
  await rm(resolve(baseDir, "apps/api/migrations", `${entry.version}.sql`));
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({
  success: true,
  replayFrom: replay[0]?.version ?? null,
  replayCount: replay.length,
})}\n`);
NODE
fi

DX_REWORK_MIGRATIONS_DIR="${base_dir}/apps/api/migrations" \
DX_REWORK_MIGRATION_MANIFEST="${base_dir}/${manifest_path}" \
node scripts/migrate.mjs

printf '{"success":true,"baseSha":"%s","seeded":true}\n' "${BASE_SHA}"
