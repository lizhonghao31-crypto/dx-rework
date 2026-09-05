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
  lineItems: [{
    position: 1,
    styleNo: "DX-100",
    alternateStyleNo: null,
    color: "黑色",
    quantity: 120,
    externalUnitPrice: "12.0000",
    legacy: false,
  }],
  daxingUnitPrice: "10.0000",
  estimatedCutPieceSendDate: "2026-09-10",
  deliveryDate: "2026-09-15",
  craftIds: ["00000000-0000-4000-8000-000000000401"],
  processes: ["净色车缝并整烫"],
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
    supplementImages: vi.fn(async () => ({
      value: {
        items: [{
          attachmentId: "00000000-0000-4000-8000-000000000301",
          filename: "evidence.webp",
          mimeType: "image/webp" as const,
        }],
      },
      reused: false,
    })),
    deleteByRoot: vi.fn(async () => ({
      value: { sourcingCaseId: caseSummary.sourcingCaseId, deleted: true as const },
      reused: false,
    })),
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
      value: { ...caseSummary, status: "pending_finance_reconciliation" as const, version: 4 },
      reused: false,
    })),
  };
  const root = { isRootUser: vi.fn(async () => isRoot) };
  const contractState = {
    item: {
      sourcingContractDocumentId: "00000000-0000-4000-8000-000000000501",
      sourcingApprovalSnapshotId: "00000000-0000-4000-8000-000000000502",
      contractNumber: "DX-WF-20260905-000001",
      contractVersion: 1,templateVersion: 1,status: "pending_supplement" as const,
      missingFields: ["address" as const],snapshotFingerprint: null,pdfAttachmentId: null,
      pdfSha256: null,failureReason: null,preparedAt: "2026-09-05T00:00:00.000Z",
      generatedAt: null,canSupplement: true,
    },
  };
  const contracts = {
    getCurrent: vi.fn(async () => contractState),
    supplement: vi.fn(async () => contractState),
    generateIfReady: vi.fn(async () => contractState),
  };
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
      contracts: contracts as never,
      root: root as never,
    },
  });
  apps.push(app);
  return { app, service, contracts };
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
        gender: "男装", styleName: "梭织短裤",
        estimatedCutPieceSendDate: "2026-09-10",
        deliveryDate: "2026-09-15",
        lineItems: [{
          styleNo: "DX-100",
          color: "黑色",
          quantity: 120,
          externalUnitPrice: "12.0000",
        }],
        daxingUnitPrice: "10.0000",
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
        gender: "男装", styleName: "梭织短裤",
        estimatedCutPieceSendDate: "2026-09-10",
        deliveryDate: "2026-09-15",
        lineItems: [{
          styleNo: "DX-100",
          color: "黑色",
          quantity: 120,
          externalUnitPrice: "12.0000",
        }],
        daxingUnitPrice: "10.0000",
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
      payload: { linePrices: [{ position: 1, unitPrice: "12.3456" }] },
    });
    expect(quoted.statusCode).toBe(201);
    expect(service.quoteIePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["ie_reviewer"],
        authorizationCapability: "sourcing:price:quote",
        requestId: "sourcing-quote-1",
      }),
      caseSummary.sourcingCaseId,
      { linePrices: [{ position: 1, unitPrice: "12.3456" }], quoteReason: undefined },
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
        gender: "男装", styleName: "梭织短裤",
        estimatedCutPieceSendDate: "2026-09-11",
        deliveryDate: "2026-09-16",
        lineItems: [{
          styleNo: "DX-101",
          color: "黑色",
          quantity: 50,
          externalUnitPrice: "12.0000",
        }],
        daxingUnitPrice: "10.0000",
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(service.createCase).not.toHaveBeenCalled();
  });

  it("requires sourcing view access and a trusted session for the list", async () => {
    const allowed = create(["sourcing:view"], ["production_management"]);
    expect((await allowed.app.inject({
      method: "GET",
      url: "/sourcing/cases?q=DX-100&status=pending&page=2",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect(allowed.service.listCases).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "sourcing:view" }),
      "DX-100",
      "pending",
      2,
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
        gender: "男装", styleName: "梭织短裤",
        estimatedCutPieceSendDate: "2026-09-12",
        deliveryDate: "2026-09-17",
        lineItems: [{
          styleNo: "DX-ROOT",
          color: "黑色",
          quantity: 10,
          externalUnitPrice: "12.0000",
        }],
        daxingUnitPrice: "10.0000",
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

    expect((await app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/management-decisions`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "root-management",
      },
      payload: {
        craftIds: ["00000000-0000-4000-8000-000000000401"],
        supplierId: "00000000-0000-4000-8000-000000000200",
        unitPrice: "8.5",
      },
    })).statusCode).toBe(201);
    expect(service.recordManagementDecision.mock.calls[0]?.[0])
      .toEqual(expect.objectContaining({
        actorRoles: ["root_superuser", "production_management"],
        authorizationCapability: "sourcing:decision:record",
      }));

    expect((await app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/owner-decisions`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "root-owner",
      },
      payload: { decision: "approved" },
    })).statusCode).toBe(201);
    expect(service.decideOwner.mock.calls[0]?.[0]).toEqual(expect.objectContaining({
      actorRoles: ["root_superuser", "owner_group"],
      authorizationCapability: "sourcing:owner:approve",
    }));
  });

  it("allows only Root to logically delete a sourcing case", async () => {
    const ordinary = create(["sourcing:view"], ["production_management"]);
    expect((await ordinary.app.inject({
      method: "DELETE",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "ordinary-delete",
      },
    })).statusCode).toBe(403);
    expect(ordinary.service.deleteByRoot).not.toHaveBeenCalled();

    const root = create([], [], true);
    const deleted = await root.app.inject({
      method: "DELETE",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "x-request-id": "sourcing-delete-1",
        "idempotency-key": "root-delete-1",
      },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toEqual({
      sourcingCaseId: caseSummary.sourcingCaseId,
      deleted: true,
    });
    expect(root.service.deleteByRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["root_superuser"],
        authorizationCapability: "sourcing:delete",
        authorizationCapabilities: ["sourcing:delete"],
        requestId: "sourcing-delete-1",
      }),
      caseSummary.sourcingCaseId,
      "root-delete-1",
    );
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
        craftIds: ["00000000-0000-4000-8000-000000000401"],
        supplierId: "00000000-0000-4000-8000-000000000200",
        linePrices: [{ position: 1, unitPrice: "12.5000" }],
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
        craftIds: ["00000000-0000-4000-8000-000000000401"],
        supplierId: "00000000-0000-4000-8000-000000000200",
        linePrices: [{ position: 1, unitPrice: "12.5000" }],
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

  it("allows sourcing workflow roles and Root to supplement images but rejects unrelated roles", async () => {
    const ie = create(["sourcing:view"], ["ie_reviewer"]);
    const supplemented = await ie.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/supplemental-images`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "x-request-id": "sourcing-images-1",
        "idempotency-key": "sourcing-images-key-1",
      },
      payload: {
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
      },
    });
    expect(supplemented.statusCode).toBe(200);
    expect(ie.service.supplementImages).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["ie_reviewer"],
        authorizationCapability: "tools:user",
        requestId: "sourcing-images-1",
      }),
      caseSummary.sourcingCaseId,
      { attachmentIds: ["00000000-0000-4000-8000-000000000301"] },
      "sourcing-images-key-1",
    );

    const unrelated = create(["sourcing:view"], ["warehouse_receiver"]);
    expect((await unrelated.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/supplemental-images`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "sourcing-images-forbidden",
      },
      payload: {
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
      },
    })).statusCode).toBe(403);
    expect(unrelated.service.supplementImages).not.toHaveBeenCalled();

    const root = create([], [], true);
    expect((await root.app.inject({
      method: "POST",
      url: `/sourcing/cases/${caseSummary.sourcingCaseId}/supplemental-images`,
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "sourcing-images-root",
      },
      payload: {
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
      },
    })).statusCode).toBe(200);
    expect(root.service.supplementImages).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["root_superuser"],
        authorizationCapability: "tools:user",
      }),
      caseSummary.sourcingCaseId,
      { attachmentIds: ["00000000-0000-4000-8000-000000000301"] },
      "sourcing-images-root",
    );
  });

  it("exposes contract state and restricts supplement actions to the order merchandiser", async () => {
    const merchandiser = create(
      ["sourcing:view", "sourcing:contract:record"],
      ["order_merchandiser"],
    );
    expect((await merchandiser.app.inject({
      method: "GET",url: `/sourcing/cases/${caseSummary.sourcingCaseId}/contract`,
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    const supplemented = await merchandiser.app.inject({
      method: "POST",url: `/sourcing/cases/${caseSummary.sourcingCaseId}/contract/supplements`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "contract-supplement-1" },
      payload: { address: "广州市番禺区" },
    });
    expect(supplemented.statusCode).toBe(200);
    expect(merchandiser.contracts.supplement).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["order_merchandiser"],
        authorizationCapability: "sourcing:contract:record",
      }),
      caseSummary.sourcingCaseId,
      { address: "广州市番禺区" },
      "contract-supplement-1",
    );

    const finance = create(["sourcing:view", "sourcing:finance:reconcile"], ["factory_payables"]);
    expect((await finance.app.inject({
      method: "POST",url: `/sourcing/cases/${caseSummary.sourcingCaseId}/contract/supplements`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "contract-forbidden" },
      payload: { address: "越权地址" },
    })).statusCode).toBe(403);
    expect(finance.contracts.supplement).not.toHaveBeenCalled();
  });

});
