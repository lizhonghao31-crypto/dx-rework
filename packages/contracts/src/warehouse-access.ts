/** The new supervisor preserves the warehouse role's existing operations. */
export const WAREHOUSE_RECEIVING_ROLES = ["warehouse_receiver", "warehouse_supervisor"] as const;
export const hasWarehouseReceivingRole = (roles: readonly string[]): boolean =>
  WAREHOUSE_RECEIVING_ROLES.some(role => roles.includes(role));

/** Retain original warehouse task identities and actual assignee roles. */
export function hasRequiredWarehouseRole(roles: readonly string[], requiredRole: string): boolean {
  return requiredRole === "warehouse_receiver" ? hasWarehouseReceivingRole(roles) : roles.includes(requiredRole);
}
