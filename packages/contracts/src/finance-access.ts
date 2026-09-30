// 2026-09-12: finance entry/read/export and paid markers are distinct permissions.
export const FINANCE_WAGE_ROLES = [
  "owner_group", "production_management", "finance_director",
  "wage_month_close_accountant", "finance_read",
] as const;

export const FINANCE_WAGE_MARK_ROLES = [
  "finance_director", "wage_month_close_accountant", "finance_read",
] as const;

export function hasFinanceWageRole(roles: readonly string[]): boolean {
  return FINANCE_WAGE_ROLES.some(role => roles.includes(role));
}

export function hasFinanceWageMarkRole(roles: readonly string[]): boolean {
  return FINANCE_WAGE_MARK_ROLES.some(role => roles.includes(role));
}
