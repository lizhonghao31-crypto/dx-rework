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
