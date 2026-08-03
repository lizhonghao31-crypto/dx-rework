import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import type {
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
  ExternalResponsibilityQueueResponse,
} from "@dx-rework/contracts/external-responsibility";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "key",
  DINGTALK_H5_APP_SECRET: "secret",
  DINGTALK_WEB_CLIENT_ID: "web",
  DINGTALK_WEB_CLIENT_SECRET: "secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/callback",
  SESSION_SECRET: "external-responsibility-routes-test-secret-longer-than-32",
});

const ids = {
  actor: randomUUID(),
  order: randomUUID(),
  batch: randomUUID(),
  case: randomUUID(),
  supplier: randomUUID(),
  determination: randomUUID(),
  item: randomUUID(),
  configuration: randomUUID(),
  revision: randomUUID(),
};
const now = "2026-08-03T00:00:00.000Z";
const caseResponse: ExternalResponsibilityCaseResponse = {
  caseId: ids.case,
  batchId: ids.batch,
  reworkOrderId: ids.order,
  responsibilityType: "processing_factory",
  supplier: {
    supplierId: ids.supplier,
    version: 1,
    code: "FAC-001",
    name: "加工厂",
    type: "factory",
  },
  businessHandlerUserId: ids.actor,
  payablesHandlerRole: "factory_payables",
  proposedDeductionAmount: "12.00",
  actualDeductedAmount: "0.00",
  remainingAmount: "12.00",
  caseVersion: 3,
  status: "pending_responsibility_revision",
  submittedAt: now,
  payablesConfirmedAt: now,
  canSign: false,
  canPayablesConfirm: false,
  canFollowUp: false,
  canRecordDeduction: false,
  canClose: false,
  canRequestRevision: false,
  canApproveRevision: true,
  items: [{
    externalItemId: ids.item,
    configurationItemId: ids.configuration,
    responsibilityType: "processing_factory",
    processSnapshot: {},
    multiplierSnapshot: "1.000",
    shareBpsSnapshot: 10000,
    proposedAmount: "12.00",
    amountLineSnapshot: {},
  }],
  deductions: [],
  followUps: [],
  closure: null,
  revisionRequests: [{
    revisionRequestId: ids.revision,
    revisionVersion: 1,
    status: "pending",
    reason: "需重判",
    requestedChange: {
      kind: "responsibility_type",
      configurationItemIds: [ids.configuration],
      targetResponsibilityType: "fabric_supplier",
    },
    requestedBy: ids.actor,
    decidedBy: null,
    decisionReason: null,
    seededDeterminationId: null,
    createdAt: now,
    decidedAt: null,
  }],
};
const batch: ExternalResponsibilityBatchResponse = {
  batchId: ids.batch,
  reworkOrderId: ids.order,
  finalizedDeterminationId: ids.determination,
  finalizedDeterminationVersion: 2,
  batchVersion: 4,
  status: "active",
  sourceSnapshot: {},
  items: caseResponse.items,
  cases: [caseResponse],
};
const queue: ExternalResponsibilityQueueResponse = {
  items: [{
    caseId: ids.case,
    reworkOrderId: ids.order,
    reworkNo: "RW-001",
    styleNo: "STYLE",
    orderNo: null,
    problemPart: "袖口",
    responsibilityType: "processing_factory",
    supplierName: "加工厂",
    status: "pending_responsibility_revision",
    proposedDeductionAmount: "12.00",
    actualDeductedAmount: "0.00",
    remainingAmount: "12.00",
    caseVersion: 3,
    overdue: false,
    canAct: false,
  }],
};

function service() {
  const response = { value: caseResponse, reused: false };
  return {
    listQueue: vi.fn().mockResolvedValue(queue),
    listSupplierOptions: vi.fn().mockResolvedValue([{
      supplierId: ids.supplier,
      supplierType: "factory" as const,
      supplierName: "加工厂",
    }]),
    get: vi.fn().mockResolvedValue(batch),
    getCase: vi.fn().mockResolvedValue(caseResponse),
    allocateSuppliers: vi.fn().mockResolvedValue({
      value: batch,
      reused: false,
    }),
    submit: vi.fn().mockResolvedValue(response),
    payablesAccept: vi.fn().mockResolvedValue(response),
    payablesReturn: vi.fn().mockResolvedValue(response),
    followUp: vi.fn().mockResolvedValue(response),
    recordDeduction: vi.fn().mockResolvedValue(response),
    close: vi.fn().mockResolvedValue(response),
    requestRevision: vi.fn().mockResolvedValue(response),
    approveRevision: vi.fn().mockResolvedValue(response),
    rejectRevision: vi.fn().mockResolvedValue(response),
  };
}

describe("external responsibility routes", () => {
  it("uses exact server-authorized queue/detail, supplier options and actions", async () => {
    const target = service();
    const app = buildApp({
      config,
      checkDatabase: vi.fn(),
      getAppliedSchemaHistory: vi.fn(),
      externalResponsibility: {
        authenticate: vi.fn().mockResolvedValue({
          id: ids.actor,
          businessRoles: ["production_management"],
          capabilities: [
            "external_responsibility:view",
            "external_responsibility:sign",
            "external_responsibility:approve_revision",
          ],
        }),
        service: target,
      },
    });
    const [listed, detail, suppliers, approved] = await Promise.all([
      app.inject({
        method: "GET",
        url: "/external-responsibilities/queue",
      }),
      app.inject({
        method: "GET",
        url: `/rework-orders/${ids.order}/external-responsibilities`,
      }),
      app.inject({
        method: "GET",
        url:
          `/rework-orders/${ids.order}/external-responsibilities/supplier-options`,
      }),
      app.inject({
        method: "POST",
        url:
          `/external-responsibility-revision-requests/${ids.revision}/approve`,
        headers: { "idempotency-key": "review-approve" },
        payload: {
          expectedCaseVersion: 3,
          expectedRevisionVersion: 1,
          reason: "允许重判",
        },
      }),
    ]);
    expect(listed.statusCode).toBe(200);
    expect(detail.statusCode).toBe(200);
    expect(suppliers.statusCode).toBe(200);
    expect(suppliers.json()).toEqual([{
      supplierId: ids.supplier,
      supplierType: "factory",
      supplierName: "加工厂",
    }]);
    expect(approved.statusCode).toBe(200);
    expect(target.listQueue).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ids.actor,
        authorizationCapability: "external_responsibility:view",
      }),
    );
    expect(target.get).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "external_responsibility:view",
      }),
      ids.order,
    );
    expect(target.listSupplierOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "external_responsibility:sign",
      }),
      ids.order,
    );
    expect(target.approveRevision).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "external_responsibility:approve_revision",
      }),
      ids.revision,
      {
        expectedCaseVersion: 3,
        expectedRevisionVersion: 1,
        reason: "允许重判",
      },
      "review-approve",
    );
    await app.close();
  });

  it("rejects client-supplied money and malformed idempotent commands before service execution", async () => {
    const target = service();
    const app = buildApp({
      config,
      checkDatabase: vi.fn(),
      getAppliedSchemaHistory: vi.fn(),
      externalResponsibility: {
        authenticate: vi.fn().mockResolvedValue({
          id: ids.actor,
          businessRoles: ["order_merchandiser"],
          capabilities: ["external_responsibility:sign"],
        }),
        service: target,
      },
    });
    const [widened, missingKey, malformed] = await Promise.all([
      app.inject({
        method: "POST",
        url:
          `/external-responsibility-batches/${ids.batch}/allocate-suppliers`,
        headers: { "idempotency-key": "no-client-money" },
        payload: {
          expectedBatchVersion: 1,
          allocations: [{
            responsibilityType: "processing_factory",
            supplierId: ids.supplier,
            externalItemIds: [ids.item],
            proposedDeductionAmount: "99.00",
          }],
        },
      }),
      app.inject({
        method: "POST",
        url: `/external-responsibility-cases/${ids.case}/submit`,
        payload: { expectedCaseVersion: 1, attachmentIds: [] },
      }),
      app.inject({
        method: "POST",
        url: "/external-responsibility-revision-requests/not-a-uuid/reject",
        headers: { "idempotency-key": "bad-revision" },
        payload: {
          expectedCaseVersion: 1,
          expectedRevisionVersion: 1,
        },
      }),
    ]);
    expect(widened.statusCode).toBe(400);
    expect(missingKey.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(target.allocateSuppliers).not.toHaveBeenCalled();
    expect(target.submit).not.toHaveBeenCalled();
    expect(target.rejectRevision).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unstructured responsibility revision requests", async () => {
    const target = service();
    const app = buildApp({
      config,
      checkDatabase: vi.fn(),
      getAppliedSchemaHistory: vi.fn(),
      externalResponsibility: {
        authenticate: vi.fn().mockResolvedValue({
          id: ids.actor,
          businessRoles: ["order_merchandiser"],
          capabilities: ["external_responsibility:request_revision"],
        }),
        service: target,
      },
    });
    const response = await app.inject({
      method: "POST",
      url: `/external-responsibility-cases/${ids.case}/revision-requests`,
      headers: { "idempotency-key": "structured-revision" },
      payload: {
        expectedCaseVersion: 3,
        requestedChange: { requestedByBusinessHandler: true },
        reason: "需重判",
        attachmentIds: [],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(target.requestRevision).not.toHaveBeenCalled();
    await app.close();
  });
});
