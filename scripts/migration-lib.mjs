import { assertAppliedMigrationHistory, assertMigrationSequence } from "./migration-history-policy.mjs";
export { assertAppliedMigrationHistory } from "./migration-history-policy.mjs";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultMigrationsDirectory = resolve(projectRoot, "apps/api/migrations");
const defaultManifestPath = resolve(projectRoot, "apps/api/src/platform/migration-manifest.json");

export async function discoverMigrations(directory = process.env.DX_REWORK_MIGRATIONS_DIR ?? defaultMigrationsDirectory) {
  const names = (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();

  return Promise.all(
    names.map(async (name) => {
      const sql = await readFile(resolve(directory, name), "utf8");
      return {
        name,
        version: name.replace(/\.sql$/, ""),
        sql,
        checksum: createHash("sha256").update(sql).digest("hex"),
      };
    }),
  );
}

export async function loadMigrationManifest(
  path = process.env.DX_REWORK_MIGRATION_MANIFEST ?? defaultManifestPath,
) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(parsed.migrations) || parsed.migrations.length === 0) {
    throw new Error("Migration manifest must contain at least one migration");
  }
  for (const entry of parsed.migrations) {
    if (
      typeof entry?.version !== "string" ||
      !/^\d{4}_[a-z0-9_]+$/.test(entry.version) ||
      typeof entry?.checksum !== "string" ||
      !/^[0-9a-f]{64}$/.test(entry.checksum)
    ) {
      throw new Error("Migration manifest contains an invalid entry");
    }
  }
  return parsed.migrations;
}

export async function discoverValidatedMigrations() {
  const [migrations, manifest] = await Promise.all([discoverMigrations(), loadMigrationManifest()]);
  if (migrations.length !== manifest.length) {
    throw new Error(`Migration manifest count mismatch: files=${migrations.length}, manifest=${manifest.length}`);
  }
  const drifts = migrations.flatMap((migration, index) => {
    const expected = manifest[index];
    return expected.version === migration.version && expected.checksum === migration.checksum
      ? []
      : [{
          version: migration.version,
          expectedVersion: expected.version,
          expectedChecksum: expected.checksum,
          actualChecksum: migration.checksum,
        }];
  });
  if (drifts.length > 0) {
    throw new Error(`Migration manifest drift detected:\n${drifts
      .map((drift) => `${drift.version}: expectedVersion=${drift.expectedVersion} expectedChecksum=${drift.expectedChecksum} actualChecksum=${drift.actualChecksum}`)
      .join("\n")}`);
  }
  assertMigrationSequence(migrations);
  return migrations;
}

export async function applyMigrations(databaseUrl) {
  const { default: pg } = await import("pg");
  const { Pool } = pg;
  const pool = new Pool({ connectionString: databaseUrl, max: 2, connectionTimeoutMillis: 5_000, query_timeout: 65_000 });
  const client = await pool.connect();
  const applied = [];
  let locked = false;
  try {
    await client.query("SET lock_timeout = '2s'");
    await client.query("SET statement_timeout = '60s'");
    const lock = await client.query("SELECT pg_try_advisory_lock(hashtext('dx-rework-schema-migrations')) AS locked");
    locked = lock.rows[0]?.locked === true;
    if (!locked) throw new Error('MIGRATION_LOCK_BUSY: no migration was started');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const migrations = await discoverValidatedMigrations();
    const storedHistory = await client.query(
      "SELECT version, checksum FROM schema_migrations ORDER BY version ASC",
    );
    assertAppliedMigrationHistory(storedHistory.rows, migrations);

    for (const migration of migrations) {
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
      if (locked) await client.query("SELECT pg_advisory_unlock(hashtext('dx-rework-schema-migrations'))");
    } finally {
      client.release();
      await pool.end();
    }
  }
}
