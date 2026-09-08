import type { Pool } from "pg";

export type StandardAcceptanceAuthorization = Readonly<{
  alias: string;
  expectedRole: string;
  activeRoles: readonly string[];
  unrevokedDelegationIds: readonly string[];
}>;

export function assertStandardAcceptanceAuthorization(
  input: StandardAcceptanceAuthorization,
): void {
  const unexpectedRoles = [...new Set(
    input.activeRoles.filter((roleCode) => roleCode !== input.expectedRole),
  )].sort();
  if (unexpectedRoles.length === 0 && input.unrevokedDelegationIds.length === 0) return;

  const details = [
    unexpectedRoles.length > 0 ? `unexpected roles: ${unexpectedRoles.join(",")}` : null,
    input.unrevokedDelegationIds.length > 0
      ? `unrevoked delegations: ${input.unrevokedDelegationIds.join(",")}`
      : null,
  ].filter((value): value is string => value !== null).join("; ");
  throw new Error(
    `Acceptance identity ${input.alias} has non-standard authorization (${details}); rebuild or explicitly clean the acceptance database before reseeding`,
  );
}

export async function preflightExistingAcceptanceIdentity(
  database: Pick<Pool, "query">,
  input: Readonly<{
    corpId: string;
    alias: string;
    expectedRole: string;
  }>,
): Promise<string | null> {
  const providerUserId = `uat-${input.alias}`;
  const identity = await database.query<{ user_id: string }>(
    `SELECT user_id FROM identity_mappings
     WHERE provider='dingtalk' AND corp_id=$1 AND provider_user_id=$2`,
    [input.corpId, providerUserId],
  );
  const userId = identity.rows[0]?.user_id;
  if (!userId) return null;

  const [roles, delegations] = await Promise.all([
    database.query<{ role_code: string }>(
      `SELECT role_code FROM user_role_assignments
       WHERE user_id=$1 AND revoked_at IS NULL
       ORDER BY role_code`,
      [userId],
    ),
    database.query<{ delegation_id: string }>(
      `SELECT delegation_id FROM delegated_authorizations
       WHERE grantee_user_id=$1 AND revoked_at IS NULL
       ORDER BY delegation_id`,
      [userId],
    ),
  ]);

  assertStandardAcceptanceAuthorization({
    alias: input.alias,
    expectedRole: input.expectedRole,
    activeRoles: roles.rows.map((row) => row.role_code),
    unrevokedDelegationIds: delegations.rows.map((row) => row.delegation_id),
  });
  return userId;
}

export type AcceptanceRootPreflight = Readonly<
  | { mode: "fresh" }
  | { mode: "existing"; userId: string }
>;

export async function preflightAcceptanceRootState(
  database: Pick<Pool, "query">,
  corpId: string,
): Promise<AcceptanceRootPreflight> {
  const [policy, identity, bootstrap] = await Promise.all([
    database.query(
      "SELECT 1 FROM access_security_policy WHERE policy_key='primary'",
    ),
    database.query<{ user_id: string }>(
      `SELECT user_id FROM identity_mappings
       WHERE provider='dingtalk' AND corp_id=$1 AND provider_user_id='uat-root'`,
      [corpId],
    ),
    database.query<{ user_id: string; provider_user_id: string; corp_id: string }>(
      `SELECT user_id,provider_user_id,corp_id
       FROM owner_bootstrap_consumptions
       WHERE singleton=true
       LIMIT 1`,
    ),
  ]);

  const policyExists = Boolean(policy.rows[0]);
  const rootUserId = identity.rows[0]?.user_id;
  const rootBootstrap = bootstrap.rows[0];

  if (!policyExists) {
    if (rootUserId || rootBootstrap) {
      throw new Error(
        "Acceptance Root is partially initialized without the security policy; rebuild the acceptance database before reseeding",
      );
    }
    return { mode: "fresh" };
  }

  if (!rootUserId) {
    throw new Error("Acceptance security policy exists but the uat-root identity is missing");
  }
  if (
    !rootBootstrap
    || rootBootstrap.user_id !== rootUserId
    || rootBootstrap.provider_user_id !== "uat-root"
    || rootBootstrap.corp_id !== corpId
  ) {
    throw new Error("Acceptance Root bootstrap is not bound to the uat-root identity");
  }

  const rootAssignment = await database.query(
    `SELECT 1 FROM user_role_assignments
     WHERE user_id=$1 AND role_code='owner_group' AND revoked_at IS NULL`,
    [rootUserId],
  );
  if (!rootAssignment.rows[0]) {
    throw new Error(
      "Acceptance security policy exists but the UAT Root owner role is missing; rebuild the acceptance database instead of bypassing guards",
    );
  }

  return { mode: "existing", userId: rootUserId };
}
