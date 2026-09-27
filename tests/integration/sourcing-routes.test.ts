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
    returnToMerchandiser:vi.fn(async()=>({value:caseSummary,reused:false})),
    correctCase:vi.fn(async()=>({value:caseSummary,reused:false})),
    nodeHistory: vi.fn(async () => ({ item: caseSummary })),
    listCases: vi.fn(async () => ({ items: [caseSummary] })),
    listMerchandisers: vi.fn(async () => [{
      userId:"00000000-0000-4000-8000-000000000002",displayName:"协同跟单",
    }]),
    listFactories: vi.fn(async () => ({
      items: [{
        supplierId: "00000000-0000-4000-8000-000000000200",
        supplierCode: "FAC-01",
        supplierName: "一号加工厂",
      }],
    })),
    reviseStyles: vi.fn(async () => ({value:caseSummary,reused:false})),
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
    recordFinanceReconciliation: vi.fn(async () => ({value:caseSummary,reused:false})),
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
  const contractReturnResponse = {
    contractReturnMonitoring: true,contractReturnStatus: "pending" as const,
    contractGeneratedAt: "2026-09-23T02:00:00.000Z",contractReturnDueAt: "2026-09-25T02:00:00.000Z",
    contractReturnedAt: null,contractReturnOverdueHours: 0,uploadedByName: null,
    canUpload: true,attachments: [],
  };
  const contractReturns = {
    get: vi.fn(async()=>contractReturnResponse),
    submit: vi.fn(async()=>contractReturnResponse),
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
      contractReturns: contractReturns as never,
      root: root as never,
    },
  });
  apps.push(app);
  return { app, service, contracts, contractReturns };
};

describe("sourcing contract return routes", () => {
  const id=caseSummary.sourcingCaseId;
  const attachmentId="00000000-0000-4000-8000-000000000301";
  it("lets an order reader see status but denies writes without the correct business role and capability", async()=>{
    const reader=create(["sourcing:view"],["factory_payables"]);
    expect((await reader.app.inject({method:"GET",url:`/sourcing/cases/${id}/contract-return`,
      headers:{cookie:"dx_rework_session=trusted"}})).statusCode).toBe(200);
    expect((await reader.app.inject({method:"POST",url:`/sourcing/cases/${id}/contract-return`,
      headers:{cookie:"dx_rework_session=trusted","idempotency-key":"return-a"},
      payload:{attachmentIds:[attachmentId]}})).statusCode).toBe(403);
    expect(reader.contractReturns.submit).not.toHaveBeenCalled();
    const owner=create(["sourcing:view","sourcing:owner:approve"],["owner_group"]);
    expect((await owner.app.inject({method:"POST",url:`/sourcing/cases/${id}/contract-return`,
      headers:{cookie:"dx_rework_session=trusted","idempotency-key":"return-b"},
      payload:{attachmentIds:[attachmentId]}})).statusCode).toBe(200);
    expect(owner.contractReturns.submit).toHaveBeenCalledWith(
      expect.objectContaining({authorizationCapability:"sourcing:owner:approve"}),id,[attachmentId],"return-b",
    );
    const manager=create(["sourcing:view","sourcing:decision:record"],["production_management"]);
    expect((await manager.app.inject({method:"POST",url:`/sourcing/cases/${id}/contract-return`,
      headers:{cookie:"dx_rework_session=trusted","idempotency-key":"return-c"},
      payload:{attachmentIds:[attachmentId]}})).statusCode).toBe(200);
    expect(manager.contractReturns.submit).toHaveBeenCalledWith(
      expect.objectContaining({authorizationCapability:"sourcing:decision:record"}),id,[attachmentId],"return-c",
    );
  });
});

describe("sourcing additional merchandiser boundary", () => {
  const headers={cookie:"dx_rework_session=trusted"};
  it("accepts one optional second merchandiser and restricts the picker to creators", async()=>{
    const creator=create(["sourcing:view","sourcing:inquiry:create"],["order_merchandiser"]);
    const candidate="00000000-0000-4000-8000-000000000002";
    expect((await creator.app.inject({method:"GET",url:"/sourcing/merchandisers",headers})).json())
      .toEqual([{userId:candidate,displayName:"协同跟单"}]);
    const payload={gender:"男装",styleName:"梭织短裤",estimatedCutPieceSendDate:"2026-09-10",
      deliveryDate:"2026-09-15",lineItems:[{styleNo:"DX-100",color:"黑色",quantity:120,externalUnitPrice:"12.00"}],
      daxingUnitPrice:"10.00",attachmentIds:["00000000-0000-4000-8000-000000000301"],
      additionalMerchandiserUserId:candidate};
    expect((await creator.app.inject({method:"POST",url:"/sourcing/cases",headers:{...headers,"idempotency-key":"add-merch"},payload})).statusCode).toBe(201);
    expect(creator.service.createCase).toHaveBeenCalledWith(expect.anything(),payload,"add-merch");
    expect((await creator.app.inject({method:"POST",url:"/sourcing/cases",headers:{...headers,"idempotency-key":"bad-add-merch"},
      payload:{...payload,additionalMerchandiserUserId:[candidate,caseSummary.createdBy]}})).statusCode).toBe(400);
    const reader=create(["sourcing:view"],["order_merchandiser"]);
    expect((await reader.app.inject({method:"GET",url:"/sourcing/merchandisers",headers})).statusCode).toBe(403);
    expect(reader.service.listMerchandisers).not.toHaveBeenCalled();
  });

  it("denies finance reconciliation to a merchandiser even if the capability is present", async()=>{
    const merchandiser=create(["sourcing:view","sourcing:finance:reconcile"],["order_merchandiser"]);
    const response=await merchandiser.app.inject({method:"POST",
      url:`/sourcing/cases/${caseSummary.sourcingCaseId}/finance-reconciliations`,
      headers:{...headers,"idempotency-key":"finance-denied"},payload:{result:"match"}});
    expect(response.statusCode).toBe(403);
    expect(merchandiser.service.recordFinanceReconciliation).not.toHaveBeenCalled();
  });
});

describe("sourcing PR03 routes", () => {
  it("reads historical nodes through the existing read permission without granting a write endpoint", async () => {
    const allowed = create(["sourcing:view"], ["order_merchandiser"]);
    const url = `/sourcing/cases/${caseSummary.sourcingCaseId}/history/ie_quote?entryId=${caseSummary.sourcingCaseId}`;
    expect((await allowed.app.inject({ method: "GET", url, headers: { cookie: "dx_rework_session=trusted" } })).statusCode).toBe(200);
    expect(allowed.service.nodeHistory).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "sourcing:view" }), caseSummary.sourcingCaseId, "ie_quote", caseSummary.sourcingCaseId);
    expect((await allowed.app.inject({ method: "POST", url, headers: { cookie: "dx_rework_session=trusted" } })).statusCode).toBe(404);
    const forbidden = create([], ["order_merchandiser"]);
    expect((await forbidden.app.inject({ method: "GET", url, headers: { cookie: "dx_rework_session=trusted" } })).statusCode).toBe(403);
    expect(forbidden.service.nodeHistory).not.toHaveBeenCalled();
  });

  it("rejects missing images and excessive new quote precision before any service write", async () => {
    const { app, service } = create([], [], true);
    const valid = { gender: "男装", styleName: "测试短裤", estimatedCutPieceSendDate: "2026-09-10", deliveryDate: "2026-09-15",
      lineItems: [{ styleNo: "TEST", color: "黑", quantity: 120, externalUnitPrice: "12.34" }], daxingUnitPrice: "10.25",
      attachmentIds: ["00000000-0000-4000-8000-000000000301"] };
    for (const override of [{ attachmentIds: [] }, { attachmentIds: undefined }, { daxingUnitPrice: "10.251" },
      { lineItems: [{ ...valid.lineItems[0], externalUnitPrice: "12.3456" }] }]) {
      expect((await app.inject({ method: "POST", url: "/sourcing/cases", headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "invalid-new-case" }, payload: { ...valid, ...override } })).statusCode).toBe(400);
    }
    expect(service.createCase).not.toHaveBeenCalled();
    for (const path of ["ie-quotes", "management-decisions"]) for (const price of ["12.3456", "10.8元", "0", "-1", "10."]) {
      expect((await app.inject({ method: "POST", url: `/sourcing/cases/${caseSummary.sourcingCaseId}/${path}`,
        headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "invalid-new-price" },
        payload: { linePrices: [{ position: 1, unitPrice: price }], ...(path === "management-decisions" ? { supplierId: "00000000-0000-4000-8000-000000000200", craftIds: ["00000000-0000-4000-8000-000000000401"] } : {}) },
      })).statusCode).toBe(400);
    }
    expect(service.quoteIePrice).not.toHaveBeenCalled();
    expect(service.recordManagementDecision).not.toHaveBeenCalled();
  });

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
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
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
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
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
      payload: { linePrices: [{ position: 1, unitPrice: "12.34" }] },
    });
    expect(quoted.statusCode).toBe(201);
    expect(service.quoteIePrice).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["ie_reviewer"],
        authorizationCapability: "sourcing:price:quote",
        requestId: "sourcing-quote-1",
      }),
      caseSummary.sourcingCaseId,
      { linePrices: [{ position: 1, unitPrice: "12.34" }], quoteReason: undefined },
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
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
      },
    });
    expect(forbidden.statusCode).toBe(403);
    expect(service.createCase).not.toHaveBeenCalled();
  });

  it("requires sourcing view access and a trusted session for the list", async () => {
    const allowed = create(["sourcing:view"], ["production_management"]);
    expect((await allowed.app.inject({
      method: "GET",
      url: "/sourcing/cases?q=DX-100&status=pending&page=2&stage=finance&gender=%E5%A5%B3%E8%A3%85&styleName=%E9%92%88%E7%BB%87",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect(allowed.service.listCases).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "sourcing:view" }),
      "DX-100",
      "pending",
      2,
      { stage: "finance", gender: "女装", styleName: "针织" },
    );
    expect((await allowed.app.inject({
      method: "GET",
      url: "/sourcing/cases?q=%E5%BC%A0%E4%B8%89&contractReturn=all_overdue",
      headers: { cookie: "dx_rework_session=trusted" },
    })).statusCode).toBe(200);
    expect(allowed.service.listCases).toHaveBeenLastCalledWith(
      expect.objectContaining({ authorizationCapability: "sourcing:view" }),
      "张三","all",1,
      { stage: "all",gender: "all",styleName: "",contractReturn: "all_overdue" },
    );
    const beforeInvalidFilters = allowed.service.listCases.mock.calls.length;
    for (const query of ["stage=bad", "gender=bad", "contractReturn=bad", `styleName=${"x".repeat(101)}`]) {
      expect((await allowed.app.inject({
        method: "GET",
        url: `/sourcing/cases?${query}`,
        headers: { cookie: "dx_rework_session=trusted" },
      })).statusCode).toBe(400);
    }
    expect(allowed.service.listCases).toHaveBeenCalledTimes(beforeInvalidFilters);

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
        attachmentIds: ["00000000-0000-4000-8000-000000000301"],
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

  it("accepts only authorized style editors and rejects economic changes in the identity endpoint",async()=>{
    const body={expectedRevision:0,lines:[{position:1,styleNo:"NEW",alternateStyleNo:null}]};
    for(const [roles,caps,root,expected] of [
      [["order_merchandiser"],["sourcing:view","sourcing:inquiry:create"],false,200],
      [["production_management"],["sourcing:view","sourcing:decision:record"],false,200],
      [[],[],true,200],[["ie_reviewer"],["sourcing:view","sourcing:price:quote"],false,403],
      [["order_merchandiser"],["sourcing:view"],false,403],
    ] as const) {
      const {app,service}=create(caps,roles,root);
      const result=await app.inject({method:"POST",url:`/sourcing/cases/${caseSummary.sourcingCaseId}/styles`,headers:{cookie:"dx_rework_session=trusted","idempotency-key":"style-route-test"},payload:body});
      expect(result.statusCode).toBe(expected);
      expect(service.reviseStyles).toHaveBeenCalledTimes(expected===200?1:0);
    }
    const {app,service}=create([],[],true);
    for(const line of [{...body.lines[0],quantity:1},{position:1,styleNo:null,alternateStyleNo:null}]) {
      expect((await app.inject({method:"POST",url:`/sourcing/cases/${caseSummary.sourcingCaseId}/styles`,headers:{cookie:"dx_rework_session=trusted","idempotency-key":"style-invalid"},payload:{...body,lines:[line]}})).statusCode).toBe(400);
    }
    expect(service.reviseStyles).not.toHaveBeenCalled();
  });

  it("limits return to owner capability and validates correction dates before writes",async()=>{
    const headers={cookie:"dx_rework_session=trusted","idempotency-key":"correction-route"};
    const allowed=create(["sourcing:view","sourcing:owner:approve"],["owner_group"]);
    const denied=create(["sourcing:view","sourcing:inquiry:create"],["order_merchandiser"]);
    const url=`/sourcing/cases/${caseSummary.sourcingCaseId}/return-to-merchandiser`;
    expect((await allowed.app.inject({method:"POST",url,headers,payload:{expectedVersion:1,reason:"日期有误"}})).statusCode).toBe(200);
    expect(allowed.service.returnToMerchandiser).toHaveBeenCalledOnce();
    expect((await denied.app.inject({method:"POST",url,headers,payload:{expectedVersion:1,reason:"日期有误"}})).statusCode).toBe(403);
    expect(denied.service.returnToMerchandiser).not.toHaveBeenCalled();
    expect((await denied.app.inject({method:"POST",url:`/sourcing/cases/${caseSummary.sourcingCaseId}/corrections`,headers,payload:{gender:"男装",styleName:"长裤",estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-09-30",expectedVersion:2,reason:"修正",lineItems:[{styleNo:"A",color:"黑",quantity:1}],attachmentIds:["00000000-0000-4000-8000-000000000301"]}})).statusCode).toBe(400);
    expect(denied.service.correctCase).not.toHaveBeenCalled();
  });

});
