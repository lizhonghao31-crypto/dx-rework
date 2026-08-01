import pg from "pg";

import { applyMigrations } from "./migration-lib.mjs";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const first = await applyMigrations(databaseUrl);
const second = await applyMigrations(databaseUrl);
if (second.applied.length !== 0) throw new Error("Migrations are not idempotent");

const { Pool } = pg;
const pool = new Pool({ connectionString: databaseUrl, max: 1 });
try {
  const requiredTables = ["schema_migrations", "audit_events", "outbox_events", "idempotency_keys"];
  const result = await pool.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1::text[])",
    [requiredTables],
  );
  const actual = new Set(result.rows.map((row) => row.tablename));
  const missing = requiredTables.filter((table) => !actual.has(table));
  if (missing.length > 0) throw new Error(`Missing migrated tables: ${missing.join(", ")}`);

  process.stdout.write(
    `${JSON.stringify({ success: true, firstApplied: first.applied, currentVersion: second.currentVersion, tables: requiredTables })}\n`,
  );
} finally {
  await pool.end();
}
