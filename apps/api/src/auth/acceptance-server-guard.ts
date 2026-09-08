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

type AcceptanceRootBinding = Readonly<{
  user_id: string;
  provider_user_id: string;
  corp_id: string;
  identity_matches: boolean;
  has_owner_role: boolean;
}>;

export async function assertAcceptanceServerDatabase(
  databaseUrl: string,
  database: Pick<Pool, "query">,
  environment: NodeJS.ProcessEnv = process.env,
  corporationId = environment.DINGTALK_CORP_ID?.trim() ?? "",
  rootDingtalkUserId = environment.ROOT_DINGTALK_USER_ID?.trim(),
): Promise<void> {
  assertAcceptanceExternalEffectsDisabled(environment);
  if (rootDingtalkUserId !== "uat-root") {
    throw new Error("Acceptance lab requires ROOT_DINGTALK_USER_ID=uat-root");
  }
  if (!corporationId) throw new Error("Acceptance lab requires DINGTALK_CORP_ID");

  assertAcceptanceDatabaseUrl(databaseUrl);
  const result = await database.query<{ current_database: string }>("SELECT current_database()");
  assertAcceptanceDatabaseName(result.rows[0]?.current_database ?? "", "connected");

  const binding = await database.query<AcceptanceRootBinding>(
    `SELECT b.user_id,b.provider_user_id,b.corp_id,
            EXISTS(
              SELECT 1 FROM identity_mappings i
              WHERE i.user_id=b.user_id
                AND i.provider='dingtalk'
                AND i.corp_id=b.corp_id
                AND i.provider_user_id=b.provider_user_id
            ) identity_matches,
            EXISTS(
              SELECT 1 FROM user_role_assignments ura
              WHERE ura.user_id=b.user_id
                AND ura.role_code='owner_group'
                AND ura.revoked_at IS NULL
            ) has_owner_role
     FROM owner_bootstrap_consumptions b
     WHERE b.singleton=true
     LIMIT 1`,
  );
  const root = binding.rows[0];
  if (
    !root
    || root.provider_user_id !== "uat-root"
    || root.corp_id !== corporationId
    || !root.identity_matches
    || !root.has_owner_role
  ) {
    throw new Error("Acceptance lab Root bootstrap must be fully bound to uat-root before API startup");
  }
}
