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
) => {
  const service = {
    createDraft: vi.fn(async () => ({ value: response, reused: false })),
    updateDraft: vi.fn(async () => ({ value: { ...response, version: 2 }, reused: false })),
    supplementOrderImages: vi.fn(async () => ({ value: { ...response, attachmentIds: ["00000000-0000-4000-8000-000000000011"], version: 2 }, reused: false })),
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
    },
  });
  apps.push(app);
  return { app, service };
};

describe("rework initiation routes", () => {
  it("derives the initiator from the session and requires an idempotency key", async () => {
    const { app, service } = create();
    const missing = await app.inject({
      method: "POST",
      url: "/rework-orders/drafts",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { styleNo: "PD20529725" },
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
      payload: { styleNo: "PD20529725" },
    });
    expect(created.statusCode).toBe(201);
    expect(service.createDraft).toHaveBeenCalledWith({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["quality_control"],
      authorizationCapability: "rework:initiate",
      authorizationCapabilities: ["rework:initiate"],
      requestId: "rework-request-1",
    }, { styleNo: "PD20529725" }, "qc-create-1");
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
      expect.objectContaining({ authorizationCapability: "rework:initiate" }),
      "00000000-0000-4000-8000-000000000010",
      {
        expectedVersion: 1,
        attachmentIds: ["00000000-0000-4000-8000-000000000011"],
      },
      "supplement-1",
    );
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
