import pg from "pg";

import { applyMigrations, loadMigrationManifest } from "./migration-lib.mjs";

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

  const expectedMigration = (await loadMigrationManifest()).at(-1);
  if (!expectedMigration) throw new Error("Migration manifest is empty");
  await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = $2", [
    "0".repeat(64),
    expectedMigration.version,
  ]);
  let checksumDriftRejected = false;
  try {
    await applyMigrations(databaseUrl);
  } catch (error) {
    checksumDriftRejected = error instanceof Error && error.message.includes("checksum drift");
  } finally {
    await pool.query("UPDATE schema_migrations SET checksum = $1 WHERE version = $2", [
      expectedMigration.checksum,
      expectedMigration.version,
    ]);
  }
  if (!checksumDriftRejected) throw new Error("Stored migration checksum drift was not rejected");

  const removedMigration = {
    version: "9999_ci_removed_migration_fixture",
    checksum: "f".repeat(64),
  };
  await pool.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
    removedMigration.version,
    removedMigration.checksum,
  ]);
  let removedMigrationRejected = false;
  try {
    await applyMigrations(databaseUrl);
  } catch (error) {
    removedMigrationRejected =
      error instanceof Error && error.message.includes("absent from Head manifest");
  } finally {
    await pool.query("DELETE FROM schema_migrations WHERE version = $1", [removedMigration.version]);
  }
  if (!removedMigrationRejected) {
    throw new Error("A migration removed from the Head manifest was not rejected");
  }

  process.stdout.write(
    `${JSON.stringify({ success: true, firstApplied: first.applied, currentVersion: second.currentVersion, checksumDriftRejected, removedMigrationRejected, tables: requiredTables })}\n`,
  );
} finally {
  await pool.end();
}
