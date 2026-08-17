import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import { buildApp } from "../../apps/api/src/app.js";
import { AuthDeniedError } from "../../apps/api/src/auth/service.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "key",
  DINGTALK_H5_APP_SECRET: "secret",
  DINGTALK_WEB_CLIENT_ID: "web",
  DINGTALK_WEB_CLIENT_SECRET: "secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/callback",
  SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters",
});
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const protectedRoles = new Set(["owner_group", "system_admin"]);

const create = (
  capabilities: readonly string[],
  businessRoles: readonly string[] = ["owner_group"],
  isRoot = false,
) => {
  const service = {
    listRoles: vi.fn(async () => [
      { roleCode: "worker", displayName: "员工", description: "", capabilities: [] },
      { roleCode: "owner_group", displayName: "老板", description: "", capabilities: [] },
      { roleCode: "system_admin", displayName: "系统管理员", description: "", capabilities: [] },
    ]),
    listRoleAssignments: vi.fn(async () => []),
    listDelegations: vi.fn(async () => []),
    listPeople: vi.fn(async () => []),
    listProcesses: vi.fn(async () => []),
    listSuppliers: vi.fn(async () => []),
    assignRole: vi.fn(async () => ({ assignmentId: "00000000-0000-4000-8000-000000000010" })),
    revokeRole: vi.fn(),
    createPerson: vi.fn(),
    addPersonAlias: vi.fn(async () => ({ aliasId: "00000000-0000-4000-8000-000000000011" })),
    revokePersonAlias: vi.fn(),
    deactivatePerson: vi.fn(),
    createProcess: vi.fn(),
    reviseProcess: vi.fn(),
    createSupplier: vi.fn(),
    reviseSupplier: vi.fn(),
    createDelegation: vi.fn(),
    revokeDelegation: vi.fn(),
  };
  const root = {
    isRootUser: vi.fn(async () => isRoot),
    isProtectedRole: (roleCode: string) => protectedRoles.has(roleCode),
    assertProtectedRoleMutation: vi.fn(async (_actorId: string, roleCode: string) => {
      if (protectedRoles.has(roleCode) && !isRoot) {
        throw new ApplicationError("FORBIDDEN", "老板和系统管理员角色仅可由超级用户维护", 403);
      }
    }),
    assertAssignmentMutation: vi.fn(async () => undefined),
    assertTargetAccessMutation: vi.fn(async () => undefined),
    filterAssignableRoles: vi.fn(async (_actorId: string, roles: Array<{ roleCode: string }>) =>
      isRoot ? roles : roles.filter((role) => !protectedRoles.has(role.roleCode))),
  };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    access: {
      authenticate: async (token) => {
        if (token !== "trusted") throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return {
          id: "00000000-0000-4000-8000-000000000001",
          displayName: "管理员",
          capabilities,
          businessRoles,
        };
      },
      service: service as never,
      root: root as never,
    },
  });
  apps.push(app);
  return { app, service, root };
};

describe("access routes", () => {
  it("returns the trusted stable-ID access snapshot", async () => {
    const { app } = create(["access:admin"]);
    const response = await app.inject({
      method: "GET",
      url: "/access/me",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      userId: "00000000-0000-4000-8000-000000000001",
      displayName: "管理员",
      businessRoles: ["owner_group"],
      capabilities: ["access:admin"],
      isRoot: false,
    });
  });

  it("derives the actor from the session and ignores no caller-supplied identity", async () => {
    const { app, service } = create(["access:admin"]);
    const response = await app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "access-request-1" },
      payload: {
        userId: "00000000-0000-4000-8000-000000000002",
        roleCode: "worker",
        reason: "入职分配",
      },
    });
    expect(response.statusCode).toBe(201);
    expect(service.assignRole.mock.calls[0]?.[0]).toEqual({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["owner_group"],
      authorizationCapability: "access:admin",
      requestId: "access-request-1",
    });
  });

  it("keeps owner and system administrator assignment root-only", async () => {
    const normalOwner = create(["access:admin"], ["owner_group"], false);
    const rejected = await normalOwner.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        userId: "00000000-0000-4000-8000-000000000002",
        roleCode: "system_admin",
        reason: "尝试授予管理员",
      },
    });
    expect(rejected.statusCode).toBe(403);
    expect(normalOwner.service.assignRole).not.toHaveBeenCalled();

    const rootOwner = create([], [], true);
    const allowed = await rootOwner.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        userId: "00000000-0000-4000-8000-000000000002",
        roleCode: "owner_group",
        reason: "超级用户授予老板",
      },
    });
    expect(allowed.statusCode).toBe(201);
    expect(rootOwner.service.assignRole).toHaveBeenCalledOnce();

    const selfSystemAdmin = await rootOwner.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "root-self-admin" },
      payload: {
        userId: "00000000-0000-4000-8000-000000000001",
        roleCode: "system_admin",
        reason: "Root 作为待办运行身份",
      },
    });
    expect(selfSystemAdmin.statusCode).toBe(201);
    expect(rootOwner.service.assignRole).toHaveBeenCalledTimes(2);
    expect(rootOwner.service.assignRole.mock.calls[1]?.[0]).toEqual({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["root_superuser"],
      authorizationCapability: "access:admin",
      requestId: "root-self-admin",
    });
  });

  it("does not let a technical administrator manage business roles", async () => {
    const administrator = create(["access:admin"], ["system_admin"], false);
    const response = await administrator.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        userId: "00000000-0000-4000-8000-000000000002",
        roleCode: "worker",
        reason: "技术管理员尝试分配业务角色",
      },
    });
    expect(response.statusCode).toBe(403);
    expect(administrator.service.assignRole).not.toHaveBeenCalled();
  });

  it("hides protected roles from non-root role options", async () => {
    const normalOwner = create(["access:admin"], ["owner_group"], false);
    const response = await normalOwner.app.inject({
      method: "GET",
      url: "/access/roles",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((role: { roleCode: string }) => role.roleCode)).toEqual(["worker"]);
  });

  it("adds an audited alias to an existing stable person ID", async () => {
    const { app, service } = create(["master_data:manage"]);
    const response = await app.inject({
      method: "POST",
      url: "/master-data/people/00000000-0000-4000-8000-000000000020/aliases",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "alias-request-1" },
      payload: { alias: "李生", reason: "纠正称呼归属" },
    });
    expect(response.statusCode).toBe(201);
    expect(service.addPersonAlias).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "00000000-0000-4000-8000-000000000001",
        authorizationCapability: "master_data:manage",
        requestId: "alias-request-1",
      }),
      "00000000-0000-4000-8000-000000000020",
      { alias: "李生", reason: "纠正称呼归属" },
    );
  });

  it("passes Root identity and any requested master-data capability to controlled person creation", async () => {
    const { app, service } = create([], [], true);
    const response = await app.inject({
      method: "POST",
      url: "/master-data/people",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "root-temporary-person" },
      payload: {
        personType: "temporary",
        displayName: "UAT临时工",
        aliases: [],
        reason: "无人值守全链路验收",
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createPerson).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "00000000-0000-4000-8000-000000000001",
        actorRoles: ["root_superuser"],
        authorizationCapability: "master_data:manage",
        authorizationCapabilities: ["master_data:manage"],
        requestId: "root-temporary-person",
      }),
      expect.objectContaining({ personType: "temporary", displayName: "UAT临时工" }),
    );
  });

  it("uses separate read capabilities for business directory consumers", async () => {
    const { app, service } = create(["supplier_catalog:read"], ["quality_control"]);
    const response = await app.inject({
      method: "GET",
      url: "/master-data/suppliers?includeInactive=false",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.listSuppliers).toHaveBeenCalledWith(false);
    expect((await app.inject({
      method: "GET",
      url: "/master-data/people",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(403);
  });

  it("exposes revoked alias history only when explicitly requested", async () => {
    const { app, service } = create(["people:read"], ["system_admin"]);
    const response = await app.inject({
      method: "GET",
      url: "/master-data/people?includeInactive=true&includeRevokedAliases=true",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(response.statusCode).toBe(200);
    expect(service.listPeople).toHaveBeenCalledWith({
      includeInactive: true,
      includeRevokedAliases: true,
    });
  });

  it("rejects empty roles, missing capabilities and untrusted sessions", async () => {
    const noRole = create(["access:admin"], [], false);
    expect((await noRole.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { userId: "00000000-0000-4000-8000-000000000002", roleCode: "worker", reason: "test" },
    })).statusCode).toBe(403);

    const forbidden = create([], ["owner_group"], false);
    expect((await forbidden.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { userId: "00000000-0000-4000-8000-000000000002", roleCode: "worker", reason: "test" },
    })).json().error.code).toBe("FORBIDDEN");

    const untrusted = create(["access:admin"]);
    expect((await untrusted.app.inject({ method: "GET", url: "/access/me" })).statusCode).toBe(401);
  });
});