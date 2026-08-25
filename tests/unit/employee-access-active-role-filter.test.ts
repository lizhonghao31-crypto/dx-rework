import { describe, expect, it } from "vitest";
import type { EmployeeAccessEmployee } from "@dx-rework/contracts/employee-access";

import {
  employeesInAccessFilter,
  hasEffectiveRoleAccess,
} from "../../apps/web/src/employee-access-filter.js";

const employee = (
  overrides: Partial<EmployeeAccessEmployee> = {},
): EmployeeAccessEmployee => ({
  userId: "11111111-1111-4111-8111-111111111111",
  providerUserId: "ding-user",
  displayName: "测试员工",
  departments: ["测试部"],
  active: true,
  employed: true,
  enabled: true,
  manualAccessDisabled: false,
  lastVerifiedAt: "2026-08-25T00:00:00.000Z",
  hasLoggedIn: false,
  businessRoles: ["worker"],
  roleHistory: [],
  ...overrides,
});

describe("employee access active-role filter", () => {
  it("requires organization activity, employment, system access and a current role", () => {
    expect(hasEffectiveRoleAccess(employee())).toBe(true);
    expect(hasEffectiveRoleAccess(employee({ active: false }))).toBe(false);
    expect(hasEffectiveRoleAccess(employee({ employed: false }))).toBe(false);
    expect(hasEffectiveRoleAccess(employee({ enabled: false }))).toBe(false);
    expect(hasEffectiveRoleAccess(employee({ businessRoles: [] }))).toBe(false);
  });

  it("keeps the existing all-employees default and filters only when selected", () => {
    const current = employee();
    const noRole = employee({
      userId: "22222222-2222-4222-8222-222222222222",
      providerUserId: "ding-no-role",
      businessRoles: [],
    });

    expect(employeesInAccessFilter([current, noRole], "all")).toEqual([current, noRole]);
    expect(employeesInAccessFilter([current, noRole], "effective-role")).toEqual([current]);
  });
});
