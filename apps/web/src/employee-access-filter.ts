import type { EmployeeAccessEmployee } from "@dx-rework/contracts/employee-access";

export type EmployeeAccessFilter = "all" | "effective-role";

export const hasEffectiveRoleAccess = (employee: EmployeeAccessEmployee): boolean =>
  employee.active
  && employee.employed
  && employee.enabled
  && employee.businessRoles.length > 0;

export const employeesInAccessFilter = (
  employees: readonly EmployeeAccessEmployee[],
  filter: EmployeeAccessFilter,
): EmployeeAccessEmployee[] =>
  filter === "effective-role"
    ? employees.filter(hasEffectiveRoleAccess)
    : [...employees];
