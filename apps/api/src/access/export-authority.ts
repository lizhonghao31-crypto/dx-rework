import { FINANCE_WAGE_ROLES } from "@dx-rework/contracts/finance-access";
import { ApplicationError } from "../platform/errors.js";

export const BUSINESS_EXPORT_ROLE_ALLOWLIST = [
  "owner_group",
  "production_management",
  "finance_director",
] as const;

export const WAGE_DATA_EXPORT_ROLE_ALLOWLIST = FINANCE_WAGE_ROLES;

const hasAnyRole = (actorRoles: readonly string[], roles: readonly string[]): boolean =>
  roles.some((role) => actorRoles.includes(role));

const deny = (): never => {
  throw new ApplicationError("FORBIDDEN", "当前身份无权导出业务数据", 403);
};

export function assertWageDataExportAllowed(actorRoles: readonly string[]): void {
  if (actorRoles.includes("root_superuser")) return;
  if (hasAnyRole(actorRoles, WAGE_DATA_EXPORT_ROLE_ALLOWLIST)) return;
  deny();
}

export function assertBusinessExportAllowed(
  actorRoles: readonly string[],
  capability = "business:export",
): void {
  if (actorRoles.includes("root_superuser")) return;
  if (capability === "wage:export") {
    assertWageDataExportAllowed(actorRoles);
    return;
  }
  if (hasAnyRole(actorRoles, BUSINESS_EXPORT_ROLE_ALLOWLIST)) return;
  deny();
}
