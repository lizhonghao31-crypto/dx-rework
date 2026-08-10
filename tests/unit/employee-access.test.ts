import { readFile } from "node:fs/promises";

import { loadConfig } from "@dx-rework/config";
import {
  EmployeeAccessBootstrapSchema,
  EmployeeAccessGrantRoleSchema,
  EmployeeAccessReasonSchema,
} from "@dx-rework/contracts/employee-access";
import { describe, expect, it } from "vitest";

const baseEnvironment = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://dx_rework:test@127.0.0.1:5432/dx_rework_test",
  DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "h5-key",
  DINGTALK_H5_APP_SECRET: "h5-secret",
  DINGTALK_WEB_CLIENT_ID: "web-client",
  DINGTALK_WEB_CLIENT_SECRET: "web-secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/rework/auth/qr/relay",
  SESSION_SECRET: "12345678901234567890123456789012",
} as const;

describe("PR-31 employee access contracts", () => {
  it("requires explicit reasons for role and access mutations", () => {
    expect(EmployeeAccessGrantRoleSchema.safeParse({ roleCode: "tail_supervisor", reason: "岗位调整" }).success).toBe(true);
    expect(EmployeeAccessGrantRoleSchema.safeParse({ roleCode: "tail_supervisor", reason: "" }).success).toBe(false);
    expect(EmployeeAccessReasonSchema.safeParse({ reason: "权限回收" }).success).toBe(true);
    expect(EmployeeAccessReasonSchema.safeParse({}).success).toBe(false);
  });

  it("keeps bootstrap default-off and supports a private root identity", () => {
    const disabled = loadConfig({ ...baseEnvironment });
    expect(disabled.ownerBootstrap.enabled).toBe(false);
    expect(disabled.rootDingtalkUserId).toBeUndefined();

    expect(() => loadConfig({
      ...baseEnvironment,
      OWNER_BOOTSTRAP_DINGTALK_USER_ID: "manager-userid",
    })).toThrow(/owner bootstrap requires both/);

    const enabled = loadConfig({
      ...baseEnvironment,
      ROOT_DINGTALK_USER_ID: "root-userid",
      OWNER_BOOTSTRAP_DINGTALK_USER_ID: "manager-userid",
      OWNER_BOOTSTRAP_SECRET: "abcdefghijklmnopqrstuvwxyz123456",
    });
    expect(enabled.rootDingtalkUserId).toBe("root-userid");
    expect(enabled.ownerBootstrap).toMatchObject({ enabled: true, dingtalkUserId: "manager-userid" });
    expect(EmployeeAccessBootstrapSchema.safeParse({
      secret: "abcdefghijklmnopqrstuvwxyz123456",
      reason: "首位老板初始化",
    }).success).toBe(true);
  });

  it("admits owners to employee access and keeps owner navigation available", async () => {
    const [app, components] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
    ]);
    expect(app).toContain('path === "/ui/employee-access"');
    expect(app).toContain('{ requiredRole: "owner_group" }');
    expect(components).toContain('hasPageAccess(body.user, { requiredRole: "owner_group", requiredCapability: "access:admin" })');
    const guard = components.indexOf("if (canManageEmployeeAccess)");
    const link = components.indexOf('name: "权限管理"');
    expect(guard).toBeGreaterThan(-1);
    expect(link).toBeGreaterThan(guard);
    expect(components.slice(link, link + 180)).toContain('href: "/ui/employee-access"');
  });

  it("keeps owner and system administrator as root-only protected roles", async () => {
    const [authority, accessRoutes, employeeRoutes, employeePage, deployLib] = await Promise.all([
      readFile("apps/api/src/access/root-authority.ts", "utf8"),
      readFile("apps/api/src/access/routes.ts", "utf8"),
      readFile("apps/api/src/access/employee-access-routes.ts", "utf8"),
      readFile("apps/web/src/employee-access-page.tsx", "utf8"),
      readFile("scripts/deploy/lib.sh", "utf8"),
    ]);
    expect(authority).toContain('new Set(["owner_group", "system_admin"])');
    expect(authority).toContain("rootDingtalkUserId");
    expect(authority).toContain("owner_bootstrap_consumptions");
    expect(authority).toContain("assertProtectedRoleMutation");
    expect(authority).toContain("assertTargetAccessMutation");
    expect(accessRoutes).toContain("filterAssignableRoles");
    expect(accessRoutes).toContain("assertProtectedRoleMutation");
    expect(employeeRoutes).toContain("assertAssignmentMutation");
    expect(employeeRoutes).toContain("assertTargetAccessMutation");
    expect(employeePage).toContain('new Set(["owner_group", "system_admin"])');
    expect(deployLib).toContain("ROOT_DINGTALK_USER_ID");
  });

  it("enforces the confirmed role-management policy at the database boundary", async () => {
    const migration = await readFile("apps/api/migrations/0035_role_management_policy_closure.sql", "utf8");
    expect(migration).toContain("access_is_root_actor");
    expect(migration).toContain("access_role_manager_roles");
    expect(migration).toContain("business roles can only be maintained by an active owner or root");
    expect(migration).toContain("protected roles can only be maintained by root");
    expect(migration).toContain("root cannot revoke its own protected role");
    expect(migration).toContain("DELETE FROM role_capabilities");
    expect(migration).toContain("role_code='system_admin' AND capability='access:admin'");
    expect(migration).toContain("('owner_group', 'access:admin')");
  });

  it("keeps owner bootstrap one-time at the database boundary", async () => {
    const migration = await readFile("apps/api/migrations/0033_employee_access_management.sql", "utf8");
    expect(migration).toContain("CREATE TABLE owner_bootstrap_consumptions");
    expect(migration).toContain("PRIMARY KEY DEFAULT true CHECK (singleton = true)");
    expect(migration).toContain("owner bootstrap has already been consumed");
    expect(migration).toContain("access.owner.bootstrap");
    expect(migration).toContain("access:bootstrap");
    expect(migration).toContain("cannot disable the last usable owner");
  });

  it("uses fail-closed DingTalk department and member pagination", async () => {
    const provider = await readFile("apps/api/src/auth/provider.ts", "utf8");
    expect(provider).toContain('/topapi/v2/department/listsub');
    expect(provider).toContain('/topapi/v2/user/list');
    expect(provider).toContain("pagination repeated a cursor");
    expect(provider).toContain("pagination did not advance");
    expect(provider).toContain("listOrganizationMembers");
    expect(provider).toContain("if (!detail) return null;");
    expect(provider).toContain("directory member could not be verified in the configured corporation");
    expect(provider).not.toContain('active: false, employed: false, displayName: "钉钉用户"');
  });

  it("records each changed directory employee with before and after access state", async () => {
    const service = await readFile("apps/api/src/access/employee-access-service.ts", "utf8");
    expect(service).toContain('action: "access.directory.employee.sync"');
    expect(service).toContain("entityId: user.id");
    expect(service).toContain("before: before ? directoryAuditState(before) : undefined");
    expect(service).toContain("after: directoryAuditState(after)");
    expect(service).toContain("providerUserId: row.provider_user_id");
    expect(service).toContain("departments: row.department_names");
    expect(service).toContain("active: row.active");
    expect(service).toContain("employed: row.employed");
  });

  it("does not expose bootstrap or root identity values in the employee page", async () => {
    const page = await readFile("apps/web/src/employee-access-page.tsx", "utf8");
    expect(page).not.toContain("OWNER_BOOTSTRAP_SECRET");
    expect(page).not.toContain("employee-access/bootstrap");
    expect(page).not.toContain("ROOT_DINGTALK_USER_ID");
  });
});
