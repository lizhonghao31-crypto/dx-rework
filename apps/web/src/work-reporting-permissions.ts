export type WorkReportingUser = Readonly<{
  capabilities: readonly string[];
  businessRoles?: readonly string[];
  isRoot?: boolean;
}>;

export const canAssignWork = (user: WorkReportingUser): boolean =>
  user.isRoot === true
  || (
    user.businessRoles?.includes("tail_supervisor") === true
    && user.capabilities.includes("work:assign")
  );

export const canAdjustActiveWorkforce = (user: WorkReportingUser): boolean =>
  user.isRoot === true
  || (
    (
      user.businessRoles?.includes("tail_supervisor") === true
      || user.businessRoles?.includes("owner_group") === true
    )
    && user.capabilities.includes("work:assignment_adjust")
  );
