export type StandardAcceptanceAuthorization = Readonly<{
  alias: string;
  expectedRole: string;
  activeRoles: readonly string[];
  unrevokedDelegationIds: readonly string[];
}>;

type Queryable = Readonly<{
  query: <Row extends Record<string, unknown>>(
    sql: string,
    params?: readonly unknown[],
  ) => Promise<{ rows: Row[] }>;
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
  database: Queryable,
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
