export type WorkReportingUser = Readonly<{
  capabilities: readonly string[];
  businessRoles?: readonly string[];
}>;

export const canAssignWork = (user: WorkReportingUser): boolean =>
  user.businessRoles?.includes("tail_supervisor") === true
  && user.capabilities.includes("work:assign");
