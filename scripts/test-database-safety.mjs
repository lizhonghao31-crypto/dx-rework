import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

export const TEST_DATABASE_MARKER = "dx-rework-isolated-test-v1";

export const requireTestDatabaseUrl = (environment = process.env) => {
  if (environment.NODE_ENV !== "test") {
    throw new Error("TEST_DATABASE_REJECTED: NODE_ENV=test is required");
  }
  const value = environment.TEST_DATABASE_URL?.trim();
  if (!value) throw new Error("TEST_DATABASE_REJECTED: explicit TEST_DATABASE_URL is required");
  const parsed = new URL(value);
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error("TEST_DATABASE_REJECTED: TEST_DATABASE_URL must use PostgreSQL");
  }
  if (!parsed.username || !parsed.pathname || parsed.pathname === "/") {
    throw new Error("TEST_DATABASE_REJECTED: TEST_DATABASE_URL must identify user and database");
  }
  return value;
};

export const validateTestDatabaseIdentity = (databaseUrl, identity) => {
  const parsed = new URL(databaseUrl);
  const expectedDatabase = decodeURIComponent(parsed.pathname.slice(1));
  const expectedUser = decodeURIComponent(parsed.username);
  if (identity.database !== expectedDatabase || identity.username !== expectedUser) {
    throw new Error("TEST_DATABASE_REJECTED: connected database identity does not match TEST_DATABASE_URL");
  }
  if (identity.marker !== TEST_DATABASE_MARKER || !identity.allowConnections || identity.isTemplate) {
    throw new Error("TEST_DATABASE_REJECTED: target is not an approved isolated test database");
  }
  if (identity.isSuperuser || identity.canCreateDatabase || identity.canCreateRole || identity.canReplicate || identity.canBypassRls) {
    throw new Error("TEST_DATABASE_REJECTED: test role has unsafe cluster-level privileges");
  }
};

export const assertTestDatabaseTarget = async (
  databaseUrl = process.env.TEST_DATABASE_URL?.trim(),
) => {
  const checkedUrl = requireTestDatabaseUrl({ ...process.env, TEST_DATABASE_URL: databaseUrl });
  const client = new pg.Client({ connectionString: checkedUrl });
  await client.connect();
  try {
    const result = await client.query(`
      SELECT current_database() AS database, current_user AS username,
        obj_description(database.oid, 'pg_database') AS marker,
        database.datallowconn AS allow_connections, database.datistemplate AS is_template,
        role.rolsuper AS is_superuser, role.rolcreatedb AS can_create_database,
        role.rolcreaterole AS can_create_role, role.rolreplication AS can_replicate,
        role.rolbypassrls AS can_bypass_rls
      FROM pg_database database
      JOIN pg_roles role ON role.rolname=current_user
      WHERE database.datname=current_database()
    `);
    const row = result.rows[0];
    if (!row) throw new Error("TEST_DATABASE_REJECTED: database identity unavailable");
    const identity = {
      database: row.database, username: row.username, marker: row.marker,
      allowConnections: row.allow_connections, isTemplate: row.is_template,
      isSuperuser: row.is_superuser, canCreateDatabase: row.can_create_database,
      canCreateRole: row.can_create_role, canReplicate: row.can_replicate, canBypassRls: row.can_bypass_rls,
    };
    validateTestDatabaseIdentity(checkedUrl, identity);
    return identity;
  } finally {
    await client.end();
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const identity = await assertTestDatabaseTarget();
  process.stdout.write(`${JSON.stringify({ status: "ok", database: identity.database, user: identity.username, marker: identity.marker })}\n`);
}
