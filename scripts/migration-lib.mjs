import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const { Pool } = pg;
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const migrationsDirectory = resolve(projectRoot, "apps/api/migrations");

export async function discoverMigrations() {
  const names = (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(migrationsDirectory, name), "utf8");
      return {
        name,
        version: name.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function applyMigrations(databaseUrl) {
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  const client = await pool.connect();
  const applied = [];
  try {
    await client.query("SELECT pg_advisory_lock(hashtext('dx-rework-schema-migrations'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    for (const migration of await discoverMigrations()) {
      const existing = await client.query(
        "SELECT checksum FROM schema_migrations WHERE version = $1",
        [migration.version],
      );
      if (existing.rows[0]) {
        if (existing.rows[0].checksum !== migration.checksum) {
          throw new Error(`Migration checksum drift detected: ${migration.version}`);
        }
        continue;
      }

      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query(
          "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
          [migration.version, migration.checksum],
        );
        await client.query("COMMIT");
        applied.push(migration.version);
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const current = await client.query(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    return { applied, currentVersion: current.rows[0]?.version ?? null };
  } finally {
    try {
      await client.query("SELECT pg_advisory_unlock(hashtext('dx-rework-schema-migrations'))");
    } finally {
      client.release();
      await pool.end();
    }
  }
}
