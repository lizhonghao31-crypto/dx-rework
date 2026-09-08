import type { Pool } from "pg";

import {
  assertAcceptanceDatabaseName,
  assertAcceptanceDatabaseUrl,
} from "./acceptance-database-guard.js";

const externalSideEffectKeys = [
  "OSS_REGION",
  "OSS_ENDPOINT",
  "OSS_BUCKET",
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "OPENAI_API_KEY",
] as const;

const assertAcceptanceExternalEffectsDisabled = (
  environment: NodeJS.ProcessEnv,
): void => {
  const configured: string[] = externalSideEffectKeys.filter((key) => environment[key]?.trim());
  const todoDeliveryEnabled = (environment.TODO_DELIVERY_ENABLED ?? environment.TODO_RUNTIME_ENABLED) === "true";
  if (todoDeliveryEnabled) configured.push("TODO_DELIVERY_ENABLED");
  if (configured.length > 0) {
    throw new Error(
      `Acceptance lab refuses external side-effect configuration: ${configured.join(", ")}`,
    );
  }
};

export async function assertAcceptanceServerDatabase(
  databaseUrl: string,
  database: Pick<Pool, "query">,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  assertAcceptanceExternalEffectsDisabled(environment);
  assertAcceptanceDatabaseUrl(databaseUrl);
  const result = await database.query<{ current_database: string }>("SELECT current_database()");
  assertAcceptanceDatabaseName(result.rows[0]?.current_database ?? "", "connected");
}
