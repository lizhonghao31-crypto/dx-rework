#!/usr/bin/env node
import fs from "node:fs";
import pg from "pg";

const { Client } = pg;
const manifestPath = process.argv[2];
if (!manifestPath) throw new Error("usage: verify-database-readiness.mjs MIGRATION_MANIFEST");
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
if (!Array.isArray(manifest.migrations) || manifest.migrations.length === 0) {
  throw new Error("migration manifest must contain entries");
}

const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query("select 1");
  const result = await client.query(
    "select version, trim(checksum) as checksum from schema_migrations order by version",
  );
  if (result.rows.length !== manifest.migrations.length) {
    throw new Error(
      `database readiness schema count mismatch: ${result.rows.length}/${manifest.migrations.length}`,
    );
  }
  for (const [index, actual] of result.rows.entries()) {
    const expected = manifest.migrations[index];
    if (actual.version !== expected?.version || actual.checksum !== expected?.checksum) {
      throw new Error(`database readiness migration drift at ${index + 1}`);
    }
  }
  const current = result.rows.at(-1);
  process.stdout.write(
    `${JSON.stringify({ status: "ready", migrationCount: result.rows.length, version: current.version, checksum: current.checksum })}\n`,
  );
} finally {
  await client.end();
}
