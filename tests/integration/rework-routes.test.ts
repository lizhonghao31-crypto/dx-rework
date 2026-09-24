import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import type { ReworkOrderResponse } from "@dx-rework/contracts";
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

const response: ReworkOrderResponse = {
  reworkOrderId: "00000000-0000-4000-8000-000000000010",
  reworkNo: null,
  status: "draft",
  styleNo: "PD20529725",
  orderNo: null,
  merchandiserUserId: null,
  processingFactory: null,
  problemPart: null,
  problemDescription: null,
  reworkQuantity: null,
  attachmentIds: [],
  hasOtherOpenStyleOrder: false,
  version: 1,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  submittedAt: null,
  cancelledAt: null,
  cancelReason: null,
};

const create = (
  businessRoles: readonly string[] = ["quality_control"],
  capabilities: readonly string[] = ["rework:initiate"],
  isRoot = false,
  listInitiationOptions?: () => Promise<{
    merchandisers: { userId: string; displayName: string }[];
    factories: { supplierId: string; supplierVersion: number; supplierName: string }[];
  }>,
) => {
  const service = {
    getReceivingEntry: vi.fn(async (receivingBatchId: string) => ({
      receivingBatchId,
      styleNo: "PD20529725",
      processingFactorySupplierId: "00000000-0000-4000-8000-000000000088",
      merchandiserUserId: "00000000-0000-4000-8000-000000000077",
      sourceImageAttachmentId: "00000000-0000-4000-8000-000000000066",
    })),
    createDraft: vi.fn(async () => ({ value: response, reused: false })),
    updateDraft: vi.fn(async () => ({ value: { ...response, version: 2 }, reused: false })),
    supplementOrderImages: vi.fn(async () => ({ value: { ...response, attachmentIds: ["00000000-0000-4000-8000-000000000011"], version: 2 }, reused: false })),
    waiveTailInspection: vi.fn(async () => ({ value: { ...response, tailInspectionRequired: false, version: 2 }, reused: false })),
    submit: vi.fn(async () => ({
      value: { ...response, reworkNo: "RW-2026-0802-001", status: "pending_process_configuration", version: 2 },
      reused: false,
    })),
    withdraw: vi.fn(async () => ({ value: response, reused: false })),
    cancel: vi.fn(async () => ({ value: { ...response, status: "cancelled" }, reused: false })),
    deleteByRoot: vi.fn(async () => ({ value: { reworkOrderId: response.reworkOrderId, deleted: true }, reused: false })),
    getOwn: vi.fn(async () => response),
    listOwn: vi.fn(async () => [response]),
    listInitiationOptions: vi.fn(async () => ({ merchandisers: [], factories: [] })),
  };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    rework: {
      authenticate: async (token) => {
        if (token !== "trusted") throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return {
          id: "00000000-0000-4000-8000-000000000001",
          displayName: "品控",
          capabilities,
          businessRoles,
        };
      },
      service: service as never,
      root: { isRootUser: vi.fn(async () => isRoot) },
      ...(listInitiationOptions ? { listInitiationOptions } : {}),
    },
  });
  apps.push(app);
  return { app, service };
};

describe("rework initiation routes", () => {
  it.each(["owner_group", "production_management"])(
    "allows %s to waive tail inspection with a reason",
    async (role) => {
      const { app, service } = create([role], ["tail_inspection:waive"]);
      const result = await app.inject({
        method: "POST",
        url: "/rework-orders/00000000-0000-4000-8000-000000000010/waive-tail-inspection",
        headers: {
          cookie: "dx_rework_session=trusted",
          "idempotency-key": `waive-tail-${role}`,
        },
        payload: { expectedVersion: 1, reason: "该订单不需要尾查" },
      });

      expect(result.statusCode).toBe(200);
      expect(service.waiveTailInspection).toHaveBeenCalledWith(
        expect.objectContaining({
          actorRoles: [role],
          authorizationCapability: "tail_inspection:waive",
          authorizationCapabilities: ["tail_inspection:waive"],
        }),
        response.reworkOrderId,
        { expectedVersion: 1, reason: "该订单不需要尾查" },
        `waive-tail-${role}`,
      );
    },
  );

  it("allows Root to waive tail inspection without a business-role assignment", async () => {
    const { app, service } = create([], [], true);
    const result = await app.inject({
      method: "POST",
      url: `/rework-orders/${response.reworkOrderId}/waive-tail-inspection`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "waive-tail-root",
      },
      payload: { expectedVersion: 1, reason: "Root 纠正旧订单" },
    });

    expect(result.statusCode).toBe(200);
    expect(service.waiveTailInspection).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["root_superuser"],
        authorizationCapability: "tail_inspection:waive",
        authorizationCapabilities: ["tail_inspection:waive"],
      }),
      response.reworkOrderId,
      { expectedVersion: 1, reason: "Root 纠正旧订单" },
      "waive-tail-root",
    );
  });

  it.each(["quality_control", "tail_supervisor", "order_merchandiser"])(
    "rejects tail inspection waiver from %s even if capability is accidentally present",
    async (role) => {
      const { app, service } = create([role], ["tail_inspection:waive"]);
      const result = await app.inject({
        method: "POST",
        url: `/rework-orders/${response.reworkOrderId}/waive-tail-inspection`,
        headers: {
          cookie: "dx_rework_session=trusted",
          "idempotency-key": `waive-tail-forbidden-${role}`,
        },
        payload: { expectedVersion: 1, reason: "不需要尾查" },
      });

      expect(result.statusCode).toBe(403);
      expect(service.waiveTailInspection).not.toHaveBeenCalled();
    },
  );

  it("derives the initiator from the session and requires an idempotency key", async () => {
    const { app, service } = create();
    const missing = await app.inject({
      method: "POST",
      url: "/rework-orders/drafts",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: {
        receivingBatchId: "00000000-0000-4000-8000-000000000099",
        styleNo: "PD20529725",
      },
    });
    expect(missing.statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: "/rework-orders/drafts",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "qc-create-1",
        "x-request-id": "rework-request-1",
      },
      payload: {
        receivingBatchId: "00000000-0000-4000-8000-000000000099",
        styleNo: "PD20529725",
      },
    });
    expect(created.statusCode).toBe(201);
    expect(service.createDraft).toHaveBeenCalledWith({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["quality_control"],
      authorizationCapability: "rework:initiate",
      authorizationCapabilities: ["rework:initiate"],
      requestId: "rework-request-1",
    }, {
      receivingBatchId: "00000000-0000-4000-8000-000000000099",
      styleNo: "PD20529725",
    }, "qc-create-1");
  });

  it("requires a receiving batch and exposes its server-side style for the board entry", async () => {
    const { app, service } = create();
    const withoutBatch = await app.inject({
      method: "POST",
      url: "/rework-orders/drafts",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "qc-create-without-batch",
      },
      payload: { styleNo: "PD20529725" },
    });
    expect(withoutBatch.statusCode).toBe(400);
    expect(service.createDraft).not.toHaveBeenCalled();

    const context = await app.inject({
      method: "GET",
      url: "/rework-orders/receiving-entry/00000000-0000-4000-8000-000000000099",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toEqual({
      receivingBatchId: "00000000-0000-4000-8000-000000000099",
      styleNo: "PD20529725",
      processingFactorySupplierId: "00000000-0000-4000-8000-000000000088",
      merchandiserUserId: "00000000-0000-4000-8000-000000000077",
      sourceImageAttachmentId: "00000000-0000-4000-8000-000000000066",
    });
    expect(service.getReceivingEntry).toHaveBeenCalledWith(
      "00000000-0000-4000-8000-000000000099",
    );
  });

  it("allows owners to enter N01 without assigning themselves the QC role", async () => {
    const { app, service } = create(["owner_group"], ["dashboard:management:read"]);
    const options = await app.inject({
      method: "GET",
      url: "/rework-orders/initiation-options",
      headers: { cookie: "dx_rework_session=trusted" },
    });
    expect(options.statusCode).toBe(200);
    expect(service.listInitiationOptions).toHaveBeenCalledWith(expect.objectContaining({
      actorRoles: ["owner_group", "quality_control"],
      authorizationCapability: "rework:initiate",
    }));
  });

  it("combines live master data with submitted-order supplier and color usage", async () => {
    const supplierId = "00000000-0000-4000-8000-000000000088";
    const { app, service } = create(
      ["quality_control"],
      ["rework:initiate"],
      false,
      async () => ({
        merchandisers: [],
        factories: [{ supplierId, supplierVersion: 3, supplierName: "常用供应商" }],
      }),
    );
    service.listInitiationOptions.mockResolvedValueOnce({
      merchandisers: [],
      factories: [{
        supplierId,
        supplierVersion: 2,
        supplierName: "旧名称",
        personalUsageCount: 7,
        globalUsageCount: 12,
        lastUsedAt: "2026-08-15T08:00:00.000Z",
      }],
      colorSuggestions: [{
        value: "藏青",
        personalUsageCount: 5,
        globalUsageCount: 9,
        lastUsedAt: "2026-08-15T08:00:00.000Z",
      }],
    });

    const result = await app.inject({
      method: "GET",
      url: "/rework-orders/initiation-options",
      headers: { cookie: "dx_rework_session=trusted" },
    });

    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual({
      merchandisers: [],
      factories: [{
        supplierId,
        supplierVersion: 3,
        supplierName: "常用供应商",
        personalUsageCount: 7,
        globalUsageCount: 12,
        lastUsedAt: "2026-08-15T08:00:00.000Z",
      }],
      colorSuggestions: [{
        value: "藏青",
        personalUsageCount: 5,
        globalUsageCount: 9,
        lastUsedAt: "2026-08-15T08:00:00.000Z",
      }],
    });
  });

  it("rejects non-QC non-owner roles even when a capability is present", async () => {
    const { app } = create(["system_admin"], ["rework:initiate"]);
    const result = await app.inject({
      method: "POST",
      url: "/rework-orders/drafts",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "forbidden-1",
      },
      payload: {},
    });
    expect(result.statusCode).toBe(403);
    expect(result.json().error.code).toBe("FORBIDDEN");
  });

  it("rejects multiple styles and carries optimistic versioning to draft updates", async () => {
    const { app, service } = create();
    const invalid = await app.inject({
      method: "POST",
      url: "/rework-orders/drafts",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "invalid-1",
      },
      payload: { styleNos: ["A", "B"] },
    });
    expect(invalid.statusCode).toBe(400);

    const updated = await app.inject({
      method: "PUT",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/draft",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "update-1",
      },
      payload: { expectedVersion: 1, orderNo: null, reworkQuantity: 281 },
    });
    expect(updated.statusCode).toBe(200);
    expect(service.updateDraft).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "rework:initiate" }),
      "00000000-0000-4000-8000-000000000010",
      { expectedVersion: 1, orderNo: null, reworkQuantity: 281 },
      "update-1",
    );
  });

  it("binds only non-empty supplemental image batches through the controlled route", async () => {
    const { app, service } = create();
    const invalid = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/supplemental-images",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "supplement-invalid-1",
      },
      payload: { expectedVersion: 1, attachmentIds: [] },
    });
    expect(invalid.statusCode).toBe(400);

    const updated = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/supplemental-images",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "supplement-1",
      },
      payload: {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
    });
    expect(updated.statusCode).toBe(200);
    expect(service.supplementOrderImages).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "tools:user" }),
      "00000000-0000-4000-8000-000000000010",
      {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
      "supplement-1",
    );
  });

  it.each([
    "tail_supervisor",
    "production_management",
    "owner_group",
    "order_merchandiser",
  ])("allows %s to supplement rework order images", async (role) => {
    const { app, service } = create([role], ["tools:user"]);
    const result = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/supplemental-images",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": `supplement-${role}`,
      },
      payload: {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
    });
    expect(result.statusCode).toBe(200);
    expect(service.supplementOrderImages).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: [role],
        authorizationCapability: "tools:user",
      }),
      "00000000-0000-4000-8000-000000000010",
      {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
      `supplement-${role}`,
    );
  });

  it("allows Root to supplement images and rejects roles outside the allowlist", async () => {
    const root = create([], [], true);
    const rootResult = await root.app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/supplemental-images",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "supplement-root",
      },
      payload: {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
    });
    expect(rootResult.statusCode).toBe(200);
    expect(root.service.supplementOrderImages).toHaveBeenCalledWith(
      expect.objectContaining({ actorRoles: ["root_superuser"] }),
      expect.any(String),
      expect.any(Object),
      "supplement-root",
    );

    const forbidden = create(["ie_reviewer"], ["tools:user"]);
    const forbiddenResult = await forbidden.app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/supplemental-images",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "supplement-forbidden",
      },
      payload: {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
    });
    expect(forbiddenResult.statusCode).toBe(403);
    expect(forbidden.service.supplementOrderImages).not.toHaveBeenCalled();
  });

  it("allows only Root to logically delete an order after a normal confirmation request", async () => {
    const root = create([], [], true);
    const deleted = await root.app.inject({
      method: "DELETE",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "root-delete-1",
        "x-request-id": "root-delete-request-1",
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({ reworkOrderId: response.reworkOrderId, deleted: true });
    expect(root.service.deleteByRoot).toHaveBeenCalledWith(expect.objectContaining({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["root_superuser"],
      authorizationCapability: "rework:delete",
      authorizationCapabilities: ["rework:delete"],
      requestId: "root-delete-request-1",
    }), response.reworkOrderId, "root-delete-1");

    const ordinary = create();
    const rejected = await ordinary.app.inject({
      method: "DELETE",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "ordinary-delete-1" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(ordinary.service.deleteByRoot).not.toHaveBeenCalled();
  });

  it("exposes the authenticated initiator's detail, filtered list and initiation options", async () => {
    const { app, service } = create();
    expect((await app.inject({
      method: "GET",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect((await app.inject({
      method: "GET",
      url: "/rework-orders?status=draft",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect(service.listOwn).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: "00000000-0000-4000-8000-000000000001" }),
      "draft",
    );
    expect((await app.inject({
      method: "GET",
      url: "/rework-orders/initiation-options",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
  });
});
