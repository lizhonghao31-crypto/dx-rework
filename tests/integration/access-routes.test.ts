import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import { buildApp } from "../../apps/api/src/app.js";
import { AuthDeniedError } from "../../apps/api/src/auth/service.js";

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

const create = (capabilities: readonly string[], businessRoles: readonly string[] = ["system_admin"]) => {
  const service = {
    listRoles: vi.fn(async () => []),
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
    },
  });
  apps.push(app);
  return { app, service };
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
      businessRoles: ["system_admin"],
      capabilities: ["access:admin"],
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
      actorRoles: ["system_admin"],
      authorizationCapability: "access:admin",
      requestId: "access-request-1",
    });
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

  it("rejects empty roles, missing capabilities and untrusted sessions", async () => {
    const noRole = create(["access:admin"], []);
    expect((await noRole.app.inject({
      method: "POST",
      url: "/access/role-assignments",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { userId: "00000000-0000-4000-8000-000000000002", roleCode: "worker", reason: "test" },
    })).json().error.code).toBe("NO_BUSINESS_ROLE");

    const forbidden = create([], ["system_admin"]);
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
