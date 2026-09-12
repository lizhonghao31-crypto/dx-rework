import { FINANCE_WAGE_ROLES, hasFinanceWageRole } from "@dx-rework/contracts/finance-access";
import type { AuthorizedUser } from "./auth.js";

export const financePageRequirements = FINANCE_WAGE_ROLES.map(requiredRole => ({ requiredRole, requiredCapability: "wage:view" }));

export function canAccessFinance(user: AuthorizedUser): boolean {
  return user.isRoot === true || (hasFinanceWageRole(user.businessRoles ?? []) && user.capabilities.includes("wage:view"));
}
