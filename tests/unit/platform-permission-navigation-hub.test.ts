import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  accessModuleIdsForCapabilities,
  accessModuleIdsForRole,
  accessModuleLabelsForCapabilities,
  employeeHasAccessModule,
  todoModuleIdsForUser,
} from "../../apps/web/src/platform-access.js";

describe("platform permission and desktop navigation hub", () => {
  it("classifies existing capabilities without creating a second permission system", () => {
    expect(accessModuleIdsForCapabilities(["rework:initiate", "sourcing:view", "access:admin"]))
      .toEqual(["rework", "sourcing", "platform"]);
    expect(accessModuleLabelsForCapabilities(["sourcing:quote:write"]))
      .toEqual(["外发定价&选厂"]);
    expect(accessModuleIdsForCapabilities(["tools:user", "todo:view", "receiving:create"]))
      .toEqual([]);
    expect(accessModuleIdsForCapabilities(["rework:initiate", "todo:view"]))
      .toEqual(["rework"]);
    expect(employeeHasAccessModule(
      ["ie_reviewer"],
      [{ roleCode: "ie_reviewer", capabilities: ["sourcing:view", "sourcing:quote:write"] }],
      "sourcing",
    )).toBe(true);
    expect(accessModuleIdsForRole("owner_group")).toEqual(["rework", "sourcing", "platform"]);
    expect(employeeHasAccessModule(["owner_group"], [], "sourcing")).toBe(true);
    expect(employeeHasAccessModule(["system_admin"], [], "platform")).toBe(true);
    expect(employeeHasAccessModule(["tail_inspector"], [], "rework")).toBe(true);
    expect(todoModuleIdsForUser({
      businessRoles: ["warehouse_receiver"],
      capabilities: ["receiving:create", "todo:view"],
    })).toEqual([]);
    expect(todoModuleIdsForUser({
      businessRoles: ["system_admin"],
      capabilities: ["admin:read", "todo:view"],
    })).toEqual([]);
    expect(todoModuleIdsForUser({
      businessRoles: ["order_merchandiser"],
      capabilities: ["quantity:confirm", "sourcing:view", "todo:view"],
    })).toEqual(["rework", "sourcing"]);
  });

  it("renders standalone global entries and permission-gated grouped desktop navigation", async () => {
    const [components, employeeAccess, systemNavigation, css] = await Promise.all([
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/employee-access-page.tsx", "utf8"),
      readFile("apps/web/src/system-management-navigation.tsx", "utf8"),
      readFile("apps/web/src/shell-navigation.css", "utf8"),
    ]);

    expect(components.indexOf('name: "我的待办"')).toBeLessThan(components.indexOf('name: "订单回货"'));
    expect(components).toContain('name: "订单返工"');
    expect(components).toContain('name: "外发定价&选厂"');
    expect(components).toContain('name: "平台管理"');
    expect(components).toContain("currentUser && canAccessSourcing(currentUser)");
    expect(components).toContain("mobileSourcingNavigation");
    expect(components).toContain('name: "外发定价&选厂"');
    expect(components).toContain('const MOBILE_PRIMARY_NAVIGATION_NAMES = ["我的待办", "订单回货", "返工单看板", "外发定价&选厂", "供应商中心"]');
    expect(components).not.toContain('name: "发起返工"');
    expect(components).toContain("currentUser && canAccessSupplierCenter(currentUser)");
    expect(components).toContain('name: "供应商目录"');
    expect(components).toContain('name: "资料维护"');
    expect(employeeAccess).toContain('<h1>人员与权限</h1>');
    expect(employeeAccess).toContain('aria-label="业务模块"');
    expect(employeeAccess).toContain("employee.isRoot");
    expect(employeeAccess).toContain("Root（订单返工 / 外发定价&选厂 / 平台管理）");
    expect(systemNavigation).toContain(">人员与权限</a>");
    expect(css).toContain(".desktop-navigation__group");
    expect(css).toContain("color: var(--dx-v2-color-surface);");
    expect(css).toContain(".desktop-navigation__group > summary:hover small");
    expect(css).toContain("var(--dx-v2-");
  });
});
