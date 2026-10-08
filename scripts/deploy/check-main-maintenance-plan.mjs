import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { assertAppliedMigrationHistory } from '../migration-history-policy.mjs';
import plans from './main-maintenance-plans.json' with { type: 'json' };
const [source] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(`${source}/apps/api/src/platform/migration-manifest.json`, 'utf8')).migrations;
const client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 5_000 });
await client.connect();
try {
  await client.query("BEGIN READ ONLY; SET LOCAL statement_timeout='5s'; SET LOCAL lock_timeout='1s'");
  const history = (await client.query('SELECT version,btrim(checksum) checksum FROM schema_migrations ORDER BY version')).rows;
  assertAppliedMigrationHistory(history, expected);
  const applied = new Set(history.map(row => row.version));
  const pending = expected.filter(row => !applied.has(row.version));
  for (const row of pending) {
    const plan = plans.find(plan => plan.version === row.version && plan.checksum === row.checksum);
    if (!plan) throw Error(`MIGRATION_PLAN_REQUIRED: ${row.version}; running service untouched`);
    const sql = readFileSync(`${source}/apps/api/migrations/${row.version}.sql`);
    if (createHash('sha256').update(sql).digest('hex') !== plan.checksum) throw Error('Migration plan fingerprint drift');
    for (const table of plan.tables) {
      const result = await client.query('SELECT pg_has_role(current_user,relowner,\'USAGE\') owns FROM pg_class WHERE oid=to_regclass($1)', [table]);
      if (result.rows[0]?.owns !== true) throw Error(`MIGRATION_PERMISSION_REQUIRED: ${table}; running service untouched`);
    }
    for (const table of plan.triggerTables ?? []) {
      const result = await client.query("SELECT has_table_privilege(current_user,$1,'TRIGGER') allowed", [table]);
      if (result.rows[0]?.allowed !== true) throw Error(`MIGRATION_PERMISSION_REQUIRED: table ${table} TRIGGER; running service untouched`);
    }
    if (plan.schema) {
      const result = await client.query("SELECT current_schema()=$1 AND has_schema_privilege(current_user,$1,'USAGE') AND has_schema_privilege(current_user,$1,'CREATE') allowed", [plan.schema]);
      if (result.rows[0]?.allowed !== true) throw Error(`MIGRATION_PERMISSION_REQUIRED: schema ${plan.schema} USAGE/CREATE/current_schema; running service untouched`);
    }
    for (const routine of plan.functions ?? []) {
      const result = await client.query("SELECT pg_has_role(current_user,proowner,'USAGE') allowed FROM pg_proc WHERE oid=to_regprocedure($1)", [routine]);
      if (result.rows[0]?.allowed !== true) throw Error(`MIGRATION_PERMISSION_REQUIRED: function ${routine} owner; running service untouched`);
    }
    for (const language of plan.languages ?? []) {
      const result = await client.query("SELECT has_language_privilege(current_user,$1,'USAGE') allowed", [language]);
      if (result.rows[0]?.allowed !== true) throw Error(`MIGRATION_PERMISSION_REQUIRED: language ${language} USAGE; running service untouched`);
    }
  }
  process.stdout.write(JSON.stringify({ pending: pending.map(row => row.version), onlineAllowed: pending.length === 0, strategy: 'quiesce-backup-transactional-ddl' }) + '\n');
} finally { await client.query('ROLLBACK'); await client.end(); }
