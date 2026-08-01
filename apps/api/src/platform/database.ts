import type { Pool } from "pg";

export type DatabaseClient = Pick<Pool, "query">;

export async function checkDatabase(database: DatabaseClient): Promise<void> {
  await database.query("SELECT 1 AS ok");
}

export async function getAppliedSchemaVersion(database: DatabaseClient): Promise<string | null> {
  try {
    const result = await database.query<{ version: string }>(
      "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1",
    );
    return result.rows[0]?.version ?? null;
  } catch (error: unknown) {
    if (isPostgresError(error) && error.code === "42P01") {
      return null;
    }
    throw error;
  }
}

function isPostgresError(error: unknown): error is { code: string } {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string";
}
