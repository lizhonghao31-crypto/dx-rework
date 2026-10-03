import {assertMigrationSequence} from './migration-history-policy.mjs';
import { discoverValidatedMigrations } from "./migration-lib.mjs";

const migrations = await discoverValidatedMigrations();
if (migrations.length === 0) throw new Error("At least one versioned migration is required");

const destructivePattern = /\b(DROP\s+(TABLE|SCHEMA|DATABASE)|TRUNCATE\s+TABLE|ALTER\s+TABLE[\s\S]*?DROP\s+COLUMN)\b/i;
assertMigrationSequence(migrations);
for (const migration of migrations) {
  if (!migration.sql.trim()) throw new Error(`Migration is empty: ${migration.name}`);
  if (destructivePattern.test(migration.sql)) {
    throw new Error(`Destructive SQL requires an explicit reviewed migration plan: ${migration.name}`);
  }
}

process.stdout.write(`${JSON.stringify({ success: true, migrations: migrations.map(({ version }) => version) })}\n`);
