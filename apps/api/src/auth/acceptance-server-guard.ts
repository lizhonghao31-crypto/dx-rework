import type { Pool } from "pg";

import {
  assertAcceptanceDatabaseName,
  assertAcceptanceDatabaseUrl,
} from "./acceptance-database-guard.js";

export async function assertAcceptanceServerDatabase(
  databaseUrl: string,
  database: Pick<Pool, "query">,
): Promise<void> {
  assertAcceptanceDatabaseUrl(databaseUrl);
  const result = await database.query<{ current_database: string }>("SELECT current_database()");
  assertAcceptanceDatabaseName(result.rows[0]?.current_database ?? "", "connected");
}
