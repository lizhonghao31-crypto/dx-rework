import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import pg from 'pg';
import { describe, it, expect } from 'vitest';
import { applyMigrations, discoverValidatedMigrations } from '../../scripts/migration-lib.mjs';
import { assertTestDatabaseTarget } from '../../scripts/test-database-safety.mjs';

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)('bounded release migration locks on real PostgreSQL', () => {
  it('refuses another migrator immediately and rolls back 0222 on a business-table lock', async () => {
    await assertTestDatabaseTarget(url!);
    const schema = ownedPostgresSchema('release_lock');
    const admin = new pg.Client({ connectionString: url }); await admin.connect();
    const scoped = new URL(url!); scoped.searchParams.set('options', `-c search_path=${schema}`);
    const database = new pg.Client({ connectionString: scoped.toString() });
    const blocker = new pg.Client({ connectionString: scoped.toString() });
    try {
      await createOwnedPostgresSchema(admin, schema); await database.connect(); await blocker.connect();
      const migrations = await discoverValidatedMigrations();
      await database.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
      for (const row of migrations.filter(row=>row.version < "0222_")) {
        await database.query('BEGIN'); await database.query(row.sql);
        await database.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [row.version, row.checksum]);
        await database.query('COMMIT');
      }
      const before = (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      await blocker.query("SELECT pg_advisory_lock(hashtext('dx-rework-schema-migrations'))");
      const start = Date.now();
      await expect(applyMigrations(scoped.toString())).rejects.toThrow('MIGRATION_LOCK_BUSY');
      expect(Date.now() - start).toBeLessThan(2_000);
      expect((await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(before);
      await blocker.query("SELECT pg_advisory_unlock(hashtext('dx-rework-schema-migrations'))");
      await blocker.query('BEGIN; LOCK TABLE cutting_orders IN ACCESS EXCLUSIVE MODE');
      const ddlStart = Date.now();
      await expect(applyMigrations(scoped.toString())).rejects.toThrow('lock timeout');
      expect(Date.now() - ddlStart).toBeLessThan(5_000);
      expect((await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows).toEqual(before);
      expect((await database.query("SELECT 1 FROM pg_constraint WHERE conrelid='sourcing_approval_snapshots'::regclass AND conname='sourcing_approval_snapshots_case_identity'")).rowCount).toBe(0);
      await blocker.query('ROLLBACK');
      expect((await applyMigrations(scoped.toString())).applied).toEqual(migrations.filter(row=>row.version >= "0222_").map(row=>row.version));
      expect((await applyMigrations(scoped.toString())).applied).toEqual([]);
      const after = (await database.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      for (const row of before) expect(after.find(r => r.version === row.version)).toEqual(row);
    } finally {
      await blocker.end(); await database.end(); await releaseOwnedPostgresSchema(admin, schema); await admin.end();
    }
  }, 120_000);
});
