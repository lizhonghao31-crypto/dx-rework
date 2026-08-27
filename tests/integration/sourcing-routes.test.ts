import type { SourcingCaseSummary } from "@dx-rework/contracts";
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

const caseSummary: SourcingCaseSummary = {
  sourcingCaseId: "00000000-0000-4000-8000-000000000100",
  erpOrderId: "ERP-100",
  erpOrderNo: "ERP-100",
  styleNo: "DX-100",
  laneKey: "garment_processing",
  orderQuantity: 120,
  status: "pending_ie_quote",
  version: 1,
  createdBy: "00000000-0000-4000-8000-000000000001",
  createdAt: "2026-08-26T00:00:00.000Z",
  updatedAt: "2026-08-26T00:00:00.000Z",
  ieQuote: null,
  decision: null,
  ownerDecision: null,
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const create = (
  capabilities: readonly string[],
  businessRoles: readonly string[],
  isRoot = false,
) => {
  const service = {
    listCases: vi.fn(async () => ({ items: [caseSummary] })),
    listFactories: vi.fn(async () => ({
      items: [{
        supplierId: "00000000-0000-4000-8000-000000000200",
        supplierCode: "FAC-01",
        supplierName: "一号加工厂",
      }],
    })),
    createCase: vi.fn(async () => ({ value: caseSummary, reused: false })),
    quoteIePrice: vi.fn(async () => ({
      value: {
        ...caseSummary,
        status: "pending_management_decision",
        version: 2,
        ieQuote: {
          sourcingIeQuoteId: "00000000-0000-4000-8000-000000000101",
          quoteVersion: 1,
          unitPrice: "12.3456",
          quantity: 120,
          totalAmount: "1481.47",
          quoteReason: "IE核定加工价格",
          quotedBy: "00000000-0000-4000-8000-000000000001",
          quotedAt: "2026-08-26T00:01:00.000Z",
        },
      },
      reused: false,
    })),
    recordManagementDecision: vi.fn(async () => ({
      value: { ...caseSummary, status: "pending_owner_approval" as const, version: 3 },
      reused: false,
    })),
    decideOwner: vi.fn(async () => ({
      value: { ...caseSummary, status: "pending_contract" as const, version: 4 },
      reused: false,
    })),
  };
  const root = { isRootUser: vi.fn(async () => isRoot) };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    sourcing: {
      authenticate: async (token) => {
        if (token !== "trusted") {
          throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        }
        return {
          id: "00000000-0000-4000-8000-000000000001",
          displayName: "测试用户",
          capabilities,
          businessRoles,
        };
      },
      service: service as never,
      root: root as never,
    },
  });
  apps.push(app);
  return { app, service };
};

describe("sourcing PR03 routes", () => {
  it("lets an authorized merchandiser create one inquiry from session identity", async () => {
    const { app, service } = create(
      ["sourcing:view", "sourcing:inquiry:create"],
      ["order_merchandiser"],
    );
    const response = await app.inject({
      method: "POST",
      url: "/sourcing/cases",
      headers: {
        cookie: "dx_rework_session=trusted",
        "x-request-id": "sourcing-create-1",
        "idempotency-key": "sourcing-create-key-1",
      },
      payload: {
        erpOrderNo: "ERP-100",
        styleNo: "DX-100",
        orderQuantity: 120,
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.createCase).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: "00000000-0000-4000-8000-000000000001",
        actorRoles: ["order_merchandiser"],
        authorizationCapability: "sourcing:inquiry:create",
        requestId: "sourcing-create-1",
      }),
      {
        erpOrderNo: "ERP-100",
        styleNo: "DX-100",
        orderQuantity: 120,
      },
      "sourcing-create-key-1",
    );
  });

  it("lets IE quote but prevents IE from creating an inquiry", async () => {
    const { app, service } = create(
      ["sourcing:view", "sourcing:price:quote"],
      ["ie_reviewer"],
    );
    const quoted = await app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/ie-quotes`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "x-request-id": "sourcing-quote-1",
        "idempotency-key": "sourcing-quote-key-1",
      },
      payload: { unitPrice: "12.3456" },
    });
    expect(quoted.statusCode).toBe(201);
    expect(service.quoteIePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["ie_reviewer"],
        authorizationCapability: "sourcing:price:quote",
        requestId: "sourcing-quote-1",
      }),
      caseSummary.sourcingCaseId,
      { unitPrice: "12.3456" },
      "sourcing-quote-key-1",
    );

    const forbidden = await app.inject({
      method: "POST",
      url: "/sourcing/cases",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "forbidden-create",
      },
      payload: {
        erpOrderNo: "ERP-101",
        styleNo: "DX-101",
        orderQuantity: 50,
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(service.createCase).not.toHaveBeenCalled();
  });

  it("requires sourcing view access and a trusted session for the list", async () => {
    const allowed = create(["sourcing:view"], ["production_management"]);
    expect((await allowed.app.inject({
      method: "GET",
      url: "/sourcing/cases?q=DX-100",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect(allowed.service.listCases).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "sourcing:view" }),
      "DX-100",
    );

    const forbidden = create([], ["production_management"]);
    expect((await forbidden.app.inject({
      method: "GET",
      url: "/sourcing/cases",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(403);
    expect(forbidden.service.listCases).not.toHaveBeenCalled();

    expect((await allowed.app.inject({
      method: "GET",
      url: "/sourcing/cases",
    })).statusCode).toBe(401);
  });

  it("keeps Root able to exercise both roles for acceptance", async () => {
    const { app, service } = create([], [], true);
    expect((await app.inject({
      method: "POST",
      url: "/sourcing/cases",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "root-create",
      },
      payload: {
        erpOrderNo: "ERP-ROOT",
        styleNo: "DX-ROOT",
        orderQuantity: 10,
      },
    })).statusCode).toBe(201);
    expect(service.createCase.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      actorRoles: ["root_superuser", "order_merchandiser"],
      authorizationCapability: "sourcing:inquiry:create",
    }));

    expect((await app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/ie-quotes`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "root-quote",
      },
      payload: { unitPrice: "8.5", quoteReason: "Root验收" },
    })).statusCode).toBe(201);
    expect(service.quoteIePrice.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      actorRoles: ["root_superuser", "ie_reviewer"],
      authorizationCapability: "sourcing:price:quote",
    }));
  });

  it("rejects malformed amount, quantity and missing idempotency key before service writes", async () => {
    const merchandiser = create(
      ["sourcing:view", "sourcing:inquiry:create"],
      ["order_merchandiser"],
    );
    expect((await merchandiser.app.inject({
      method: "POST",
      url: "/sourcing/cases",
      headers: { cookie: "dx_rework_session=trusted" },
      payload: { erpOrderNo: "ERP-1", styleNo: "DX-1", orderQuantity: 1 },
    })).statusCode).toBe(400);

    const ie = create(["sourcing:view", "sourcing:price:quote"], ["ie_reviewer"]);
    expect((await ie.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/ie-quotes`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "bad-price",
      },
      payload: { unitPrice: "1.23456" },
    })).statusCode).toBe(400);
    expect(ie.service.quoteIePrice).not.toHaveBeenCalled();
  });

  it("enforces production-management and owner roles for the approval chain", async () => {
    const manager = create(
      ["sourcing:view", "sourcing:decision:record"],
      ["production_management"],
    );
    expect((await manager.app.inject({
      method: "GET",
      url: "/sourcing/factories",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    const decided = await manager.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/management-decisions`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "x-request-id": "management-1",
        "idempotency-key": "management-key-1",
      },
      payload: {
        supplierId: "00000000-0000-4000-8000-000000000200",
        unitPrice: "12.5000",
        decisionReason: "结合工厂产能调整",
      },
    });
    expect(decided.statusCode).toBe(201);
    expect(manager.service.recordManagementDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["production_management"],
        authorizationCapability: "sourcing:decision:record",
      }),
      caseSummary.sourcingCaseId,
      {
        supplierId: "00000000-0000-4000-8000-000000000200",
        unitPrice: "12.5000",
        decisionReason: "结合工厂产能调整",
      },
      "management-key-1",
    );

    const owner = create(
      ["sourcing:view", "sourcing:owner:approve"],
      ["owner_group"],
    );
    const rejected = await owner.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/owner-decisions`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "owner-key-1",
      },
      payload: { decision: "rejected", decisionReason: "请重新核对价格" },
    });
    expect(rejected.statusCode).toBe(201);
    expect(owner.service.decideOwner).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["owner_group"],
        authorizationCapability: "sourcing:owner:approve",
      }),
      caseSummary.sourcingCaseId,
      { decision: "rejected", decisionReason: "请重新核对价格" },
      "owner-key-1",
    );

    const ie = create(["sourcing:view", "sourcing:price:quote"], ["ie_reviewer"]);
    expect((await ie.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/owner-decisions`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "forbidden-owner",
      },
      payload: { decision: "approved" },
    })).statusCode).toBe(403);
    expect(ie.service.decideOwner).not.toHaveBeenCalled();
  });

});
