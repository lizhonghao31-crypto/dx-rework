import { discoverValidatedMigrations } from "./migration-lib.mjs";

const migrations = await discoverValidatedMigrations();
if (migrations.length === 0) throw new Error("At least one versioned migration is required");

const destructivePattern = /\b(DROP\s+(TABLE|SCHEMA|DATABASE)|TRUNCATE\s+TABLE|ALTER\s+TABLE[\s\S]*?DROP\s+COLUMN)\b/i;
for (const [index, migration] of migrations.entries()) {
  const expectedPrefix = String(index + 1).padStart(4, "0");
  if (!migration.name.startsWith(`${expectedPrefix}_`)) {
    throw new Error(`Migration sequence gap: expected ${expectedPrefix}, found ${migration.name}`);
  }
  if (!migration.sql.trim()) throw new Error(`Migration is empty: ${migration.name}`);
  if (destructivePattern.test(migration.sql)) {
    throw new Error(`Destructive SQL requires an explicit reviewed migration plan: ${migration.name}`);
  }
}

process.stdout.write(`${JSON.stringify({ success: true, migrations: migrations.map(({ version }) => version) })}\n`);
