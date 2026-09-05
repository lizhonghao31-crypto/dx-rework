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
    listCrafts: vi.fn(async () => []),
    ensureCrafts: vi.fn(async () => []),
    listCraftHistory: vi.fn(async () => []),
    reviseCraft: vi.fn(async () => ({ craftId: "00000000-0000-4000-8000-000000000040", version: 2 })),
    listProcesses: vi.fn(async () => []),
    listProcessPage: vi.fn(async (input: { page?: number }) => ({ items: [], page: input.page ?? 1, pageSize: 15 as const, totalCount: 0, totalPages: 1 })),
    listProcessDefaultWorkerCandidates: vi.fn(async () => []),
    listSuppliers: vi.fn(async () => []),
    getSupplier: vi.fn(async () => ({ supplierId: "00000000-0000-4000-8000-000000000050" })),
    listSupplierHistory: vi.fn(async () => []),
    assignRole: vi.fn(async () => ({ assignmentId: "00000000-0000-4000-8000-000000000010" })),
    revokeRole: vi.fn(),
    createPerson: vi.fn(),
    getTemporaryWorkerProfile: vi.fn(async () => ({
      personId: "00000000-0000-4000-8000-000000000030",
      displayName: "临时工甲",
      temporaryRemark: null,
      temporaryPhoneNumber: "13800138000",
      temporaryIdentityNumber: null,
    })),
    updateTemporaryWorkerProfile: vi.fn(async () => ({
      personId: "00000000-0000-4000-8000-000000000030",
      displayName: "临时工甲",
      temporaryRemark: "旺季",
      temporaryPhoneNumber: "13900139000",
      temporaryIdentityNumber: null,
    })),
    addPersonAlias: vi.fn(async () => ({ aliasId: "00000000-0000-4000-8000-000000000011" })),
    revokePersonAlias: vi.fn(),
    deactivatePerson: vi.fn(),
    createProcess: vi.fn(),
    reviseProcess: vi.fn(),
    replaceProcessDefaultWorkers: vi.fn(async () => ({ processId: "00000000-0000-4000-8000-000000000020", rosterVersion: 1, personIds: [] })),
    replaceTailInspectionDefaultWorkers: vi.fn(async () => ({ executionKind: "tail_inspection" as const, rosterVersion: 1, personIds: [] })),
    createSupplier: vi.fn(async () => ({ supplierId: "00000000-0000-4000-8000-000000000050", version: 1 })),
    reviseSupplier: vi.fn(async () => ({ supplierId: "00000000-0000-4000-8000-000000000050", version: 2 })),
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

  it("lets only an authorized N02 manager read and update a temporary worker profile", async () => {
    const personId = "00000000-0000-4000-8000-000000000030";
    const tailSupervisor = create(
      ["temporary_worker:manage", "temporary_worker_private:read"],
      ["tail_supervisor"],
    );
    const loaded = await tailSupervisor.app.inject({
      method: "GET",
      url: `/master-data/temporary-workers/${personId}`,
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "temporary-profile-read" },
    });
    expect(loaded.statusCode).toBe(200);
    expect(tailSupervisor.service.getTemporaryWorkerProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor"],
        authorizationCapability: "temporary_worker:manage",
        authorizationCapabilities: ["temporary_worker:manage", "temporary_worker_private:read"],
      }),
      personId,
    );

    const updated = await tailSupervisor.app.inject({
      method: "PUT",
      url: `/master-data/temporary-workers/${personId}`,
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "temporary-profile-update" },
      payload: {
        temporaryRemark: "旺季",
        temporaryPhoneNumber: "13900139000",
        temporaryIdentityNumber: null,
        reason: "N02 补录临时工资料",
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(tailSupervisor.service.updateTemporaryWorkerProfile).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: "temporary-profile-update" }),
      personId,
      {
        temporaryRemark: "旺季",
        temporaryPhoneNumber: "13900139000",
        temporaryIdentityNumber: null,
        reason: "N02 补录临时工资料",
      },
    );

    const missingPrivateRead = create(["temporary_worker:manage"], ["owner_group"]);
    expect((await missingPrivateRead.app.inject({
      method: "GET",
      url: `/master-data/temporary-workers/${personId}`,
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(403);
    expect(missingPrivateRead.service.getTemporaryWorkerProfile).not.toHaveBeenCalled();

    const wrongRole = create(
      ["temporary_worker:manage", "temporary_worker_private:read"],
      ["finance_read"],
    );
    expect((await wrongRole.app.inject({
      method: "PUT",
      url: `/master-data/temporary-workers/${personId}`,
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        temporaryRemark: null,
        temporaryPhoneNumber: null,
        temporaryIdentityNumber: null,
        reason: "越权尝试",
      },
    })).statusCode).toBe(403);
    expect(wrongRole.service.updateTemporaryWorkerProfile).not.toHaveBeenCalled();
  });

  it("lets production managers read and create reusable sourcing crafts", async () => {
    const { app, service } = create(["sourcing:decision:record"], ["production_management"]);
    const read = await app.inject({
      method: "GET",
      url: "/master-data/crafts?q=水洗",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(read.statusCode).toBe(200);
    expect(service.listCrafts).toHaveBeenCalledWith("水洗", false);

    const created = await app.inject({
      method: "POST",
      url: "/master-data/crafts/ensure",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "craft-request-1" },
      payload: { craftNames: ["水洗", "整烫"] },
    });
    expect(created.statusCode).toBe(200);
    expect(service.ensureCrafts).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "00000000-0000-4000-8000-000000000001",
        actorRoles: ["production_management"],
        authorizationCapability: "sourcing:decision:record",
        requestId: "craft-request-1",
      }),
      { craftNames: ["水洗", "整烫"] },
    );

    const wrongRole = create(["sourcing:decision:record"], ["quality_control"]);
    expect((await wrongRole.app.inject({
      method: "POST",
      url: "/master-data/crafts/ensure",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { craftNames: ["车缝"] },
    })).statusCode).toBe(403);
    expect(wrongRole.service.ensureCrafts).not.toHaveBeenCalled();

    const craftId = "00000000-0000-4000-8000-000000000040";
    const history = await app.inject({
      method: "GET",
      url: `/master-data/crafts/${craftId}/history`,
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(history.statusCode).toBe(200);
    expect(service.listCraftHistory).toHaveBeenCalledWith(craftId);

    const manager = create(["master_data:manage"], ["system_admin"]);
    const revised = await manager.app.inject({
      method: "POST",
      url: `/master-data/crafts/${craftId}/versions`,
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "craft-revise-1" },
      payload: { craftName: "成衣水洗", active: false, changeReason: "暂时停用" },
    });
    expect(revised.statusCode).toBe(200);
    expect(manager.service.reviseCraft).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "master_data:manage",
        requestId: "craft-revise-1",
      }),
      craftId,
      { craftName: "成衣水洗", active: false, changeReason: "暂时停用" },
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

  it("separates supplier profile, contract-data, and root-only write access", async () => {
    const supplierId = "00000000-0000-4000-8000-000000000050";
    const profileReader = create(["supplier_profile:read"], ["order_merchandiser"]);
    const detail = await profileReader.app.inject({
      method: "GET",
      url: `/master-data/suppliers/${supplierId}`,
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(detail.statusCode).toBe(200);
    expect(profileReader.service.getSupplier).toHaveBeenCalledWith(supplierId, false);

    const contractReader = create(
      ["supplier_profile:read", "supplier_contract_data:read"],
      ["factory_payables"],
    );
    expect((await contractReader.app.inject({
      method: "GET",
      url: `/master-data/suppliers/${supplierId}/history`,
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect(contractReader.service.listSupplierHistory).toHaveBeenCalledWith(supplierId, true);

    const deniedReader = create(["tools:user"], ["worker"]);
    expect((await deniedReader.app.inject({
      method: "GET",
      url: `/master-data/suppliers/${supplierId}`,
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(403);
    expect(deniedReader.service.getSupplier).not.toHaveBeenCalled();

    const nonRootWriter = create(["supplier_profile:write"], ["system_admin"], false);
    expect((await nonRootWriter.app.inject({
      method: "POST",
      url: "/master-data/suppliers",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        supplierCode: "FACTORY_01",
        supplierType: "factory",
        supplierName: "加工厂一",
        changeReason: "供应商建档",
      },
    })).statusCode).toBe(403);
    expect(nonRootWriter.service.createSupplier).not.toHaveBeenCalled();

    const rootWriter = create([], [], true);
    const created = await rootWriter.app.inject({
      method: "POST",
      url: "/master-data/suppliers",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "ssp-01-create" },
      payload: {
        supplierCode: "FACTORY_01",
        supplierType: "factory",
        supplierName: "加工厂一",
        contactPerson: "陈经理",
        supportedCrafts: ["车缝"],
        dailyCapacity: 1200,
        changeReason: "供应商建档",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(rootWriter.service.createSupplier).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "supplier_profile:write",
        actorRoles: ["root_superuser"],
        requestId: "ssp-01-create",
      }),
      expect.objectContaining({
        supplierName: "加工厂一",
        notes: "",
        supportedCrafts: ["车缝"],
        dailyCapacity: 1200,
      }),
    );

    expect((await rootWriter.app.inject({
      method: "POST",
      url: `/master-data/suppliers/${supplierId}/versions`,
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        supplierName: "加工厂一号",
        active: false,
        notes: "暂停合作",
        supportedCrafts: [],
        expectedVersion: 1,
        changeReason: "暂停新订单选厂",
      },
    })).statusCode).toBe(201);
    expect(rootWriter.service.reviseSupplier).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "supplier_profile:write" }),
      supplierId,
      expect.objectContaining({ expectedVersion: 1, active: false }),
    );

    expect((await rootWriter.app.inject({
      method: "POST",
      url: `/master-data/suppliers/${supplierId}/versions`,
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        supplierName: "缺少并发版本",
        active: true,
        changeReason: "无效请求",
      },
    })).statusCode).toBe(400);
  });

  it("maintains process default workers through the master-data authority", async () => {
    const { app, service } = create(["master_data:manage"], ["system_admin"]);
    expect((await app.inject({
      method: "GET",
      url: "/master-data/process-default-worker-candidates",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    const response = await app.inject({
      method: "PUT",
      url: "/master-data/processes/00000000-0000-4000-8000-000000000020/default-workers",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        personIds: ["00000000-0000-4000-8000-000000000021"],
        changeReason: "维护工序默认人员",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(service.replaceProcessDefaultWorkers).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "master_data:manage" }),
      "00000000-0000-4000-8000-000000000020",
      { personIds: ["00000000-0000-4000-8000-000000000021"], changeReason: "维护工序默认人员" },
    );
  });

  it("lets only an authorized tail supervisor maintain defaults from N02", async () => {
    const tailSupervisor = create(["process:configure", "work:assign"], ["tail_supervisor"]);
    const allowed = await tailSupervisor.app.inject({
      method: "PUT",
      url: "/master-data/processes/00000000-0000-4000-8000-000000000020/default-workers",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "n02-default-workers" },
      payload: {
        personIds: ["00000000-0000-4000-8000-000000000021"],
        changeReason: "尾部主管在工序分配区维护默认工人",
      },
    });
    expect(allowed.statusCode).toBe(200);
    expect(tailSupervisor.service.replaceProcessDefaultWorkers).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor"],
        authorizationCapability: "process:configure",
        requestId: "n02-default-workers",
      }),
      "00000000-0000-4000-8000-000000000020",
      expect.objectContaining({ personIds: ["00000000-0000-4000-8000-000000000021"] }),
    );

    const worker = create(["process:configure", "work:assign"], ["worker"]);
    expect((await worker.app.inject({
      method: "PUT",
      url: "/master-data/processes/00000000-0000-4000-8000-000000000020/default-workers",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { personIds: [], changeReason: "越权尝试" },
    })).statusCode).toBe(403);
    expect(worker.service.replaceProcessDefaultWorkers).not.toHaveBeenCalled();

    const incompleteTailSupervisor = create(["process:configure"], ["tail_supervisor"]);
    expect((await incompleteTailSupervisor.app.inject({
      method: "PUT",
      url: "/master-data/processes/00000000-0000-4000-8000-000000000020/default-workers",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { personIds: [], changeReason: "缺少分配权限" },
    })).statusCode).toBe(403);
    expect(incompleteTailSupervisor.service.replaceProcessDefaultWorkers).not.toHaveBeenCalled();
  });

  it("uses the same explicit default-roster authority for tail inspection", async () => {
    const tailSupervisor = create(["process:configure", "work:assign"], ["tail_supervisor"]);
    const response = await tailSupervisor.app.inject({
      method: "PUT",
      url: "/master-data/tail-inspection/default-workers",
      headers: { cookie: "dx_rework_session=trusted", "x-request-id": "n02-tail-default-workers" },
      payload: {
        personIds: ["00000000-0000-4000-8000-000000000021"],
        changeReason: "尾部主管在工序分配区维护尾查默认工人",
      },
    });
    expect(response.statusCode).toBe(200);
    expect(tailSupervisor.service.replaceTailInspectionDefaultWorkers).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor"],
        authorizationCapability: "process:configure",
        requestId: "n02-tail-default-workers",
      }),
      expect.objectContaining({ personIds: ["00000000-0000-4000-8000-000000000021"] }),
    );

    const worker = create(["process:configure", "work:assign"], ["worker"]);
    expect((await worker.app.inject({
      method: "PUT",
      url: "/master-data/tail-inspection/default-workers",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { personIds: [], changeReason: "越权尝试" },
    })).statusCode).toBe(403);
    expect(worker.service.replaceTailInspectionDefaultWorkers).not.toHaveBeenCalled();
  });


  it("serves a filtered process catalog page without changing the legacy list", async () => {
    const { app, service } = create(["process_catalog:read"], ["quality_control"]);
    const response = await app.inject({
      method: "GET",
      url: "/master-data/process-catalog?includeInactive=true&q=%25&page=2",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ items: [], page: 2, pageSize: 15, totalCount: 0, totalPages: 1 });
    expect(service.listProcessPage).toHaveBeenCalledWith({
      includeInactive: true,
      query: "%",
      page: 2,
    });
    expect(service.listProcesses).not.toHaveBeenCalled();
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
    }, expect.objectContaining({
      actorRoles: ["system_admin"],
      authorizationCapability: "people:read",
    }));
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
