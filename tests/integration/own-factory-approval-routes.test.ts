import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import type {
  OwnFactoryApprovalQueueResponse,
  OwnFactoryApprovalResponse,
} from "@dx-rework/contracts";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";

const testConfig = loadConfig({
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

const orderId = randomUUID();
const approvalId = randomUUID();
const determinationId = randomUUID();
const reviewId = randomUUID();
const configurationItemId = randomUUID();
const workReportId = randomUUID();
const personId = randomUUID();
const actorId = randomUUID();

const response: OwnFactoryApprovalResponse = {
  reworkOrderId: orderId,
  reworkStatus: "pending_responsibility_action",
  orderVersion: 10,
  canView: true,
  canDecide: true,
  approval: {
    approvalId,
    finalizedDeterminationId: determinationId,
    finalizedDeterminationVersion: 2,
    approvalVersion: 1,
    status: "pending",
    ownFactoryTotalAmount: "185.46",
    sourceSnapshot: {
      finalizedDetermination: {
        determinationId,
        determinationVersion: 2,
        sourceOrderReviewId: reviewId,
        calculationTotal: "185.46",
        determinedBy: actorId,
        highMultiplierConfirmation: null,
      },
      order: {
        reworkOrderId: orderId,
        reworkNo: "RW-2026-0803-010",
        styleNo: "PD-010",
        orderNo: null,
        problemPart: "袖口",
        problemDescription: "锁定快照",
      },
      processes: [{
        configurationItemId,
        processName: "返查",
        pricingUnit: "piece",
        baseAmount: "154.55000000",
        responsibilityAmount: "185.46",
        multiplier: "1.200",
        ownFactoryShareBps: 10000,
        ownFactoryRoundedAmount: "185.46",
      }],
      amountLines: [{
        configurationItemId,
        workReportId,
        personId,
        baseMemberShareAmount: "154.55000000",
        multiplier: "1.200",
        shareBps: 10000,
        roundedAmount: "185.46",
        workerDisplayName: "Worker",
        taskMode: "individual",
        memberSnapshot: {},
        reportSnapshot: {},
      }],
    },
    createdAt: "2026-08-03T00:00:00.000Z",
    decision: null,
  },
  history: [{
    approvalId,
    finalizedDeterminationId: determinationId,
    finalizedDeterminationVersion: 2,
    approvalVersion: 1,
    status: "pending",
    ownFactoryTotalAmount: "185.46",
    createdAt: "2026-08-03T00:00:00.000Z",
    decision: null,
  }],
};

const queue: OwnFactoryApprovalQueueResponse = {
  items: [{
    approvalId,
    reworkOrderId: orderId,
    reworkNo: "RW-2026-0803-010",
    styleNo: "PD-010",
    orderNo: null,
    problemPart: "袖口",
    orderVersion: 10,
    approvalVersion: 1,
    status: "pending",
    ownFactoryTotalAmount: "185.46",
    canDecide: true,
  }],
};

const user = {
  id: actorId,
  businessRoles: ["owner_group"],
  capabilities: ["own_factory:view", "own_factory:approve"],
};

function buildService() {
  return {
    listQueue: vi.fn().mockResolvedValue(queue),
    get: vi.fn().mockResolvedValue(response),
    approve: vi.fn().mockResolvedValue({ value: response, reused: false }),
    reject: vi.fn().mockResolvedValue({ value: response, reused: false }),
  };
}

function buildTestApp(service = buildService()) {
  const authenticate = vi.fn().mockResolvedValue(user);
  const app = buildApp({
    config: testConfig,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    ownFactoryApproval: { authenticate, service },
  });
  return { app, service };
}

describe("own-factory approval routes", () => {
  it("uses the server-authorized queue and concrete rework-order detail", async () => {
    const { app, service } = buildTestApp();
    const [listed, detail] = await Promise.all([
      app.inject({ method: "GET", url: "/own-factory-approvals/queue" }),
      app.inject({ method: "GET", url: `/rework-orders/${orderId}/own-factory-approval` }),
    ]);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual(queue);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(response);
    expect(service.listQueue).toHaveBeenCalledWith(expect.objectContaining({
      actorId,
      authorizationCapability: "own_factory:view",
    }));
    expect(service.get).toHaveBeenCalledWith(expect.objectContaining({
      actorId,
      authorizationCapability: "own_factory:view",
    }), orderId);
    await app.close();
  });

  it("sends exact expected versions and idempotency for terminal decisions", async () => {
    const { app, service } = buildTestApp();
    const approve = {
      expectedOrderVersion: 10,
      expectedApprovalVersion: 1,
      opinion: "快照已核对",
    };
    const reject = {
      expectedOrderVersion: 10,
      expectedApprovalVersion: 1,
      opinion: "请补充责任依据",
    };
    const [approved, rejected] = await Promise.all([
      app.inject({ method: "POST", url: `/own-factory-approvals/${approvalId}/approve`, headers: { "idempotency-key": "approve-route" }, payload: approve }),
      app.inject({ method: "POST", url: `/own-factory-approvals/${approvalId}/reject`, headers: { "idempotency-key": "reject-route" }, payload: reject }),
    ]);
    expect(approved.statusCode).toBe(200);
    expect(rejected.statusCode).toBe(200);
    expect(service.approve).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "own_factory:approve" }), approvalId, approve, "approve-route");
    expect(service.reject).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "own_factory:approve" }), approvalId, reject, "reject-route");
    await app.close();
  });

  it("rejects malformed, widened, or non-idempotent terminal commands", async () => {
    const { app, service } = buildTestApp();
    const [missingKey, extraField, malformed] = await Promise.all([
      app.inject({ method: "POST", url: `/own-factory-approvals/${approvalId}/approve`, payload: {} }),
      app.inject({ method: "POST", url: `/own-factory-approvals/${approvalId}/reject`, headers: { "idempotency-key": "strict-route" }, payload: { expectedOrderVersion: 10, expectedApprovalVersion: 1, opinion: "原因", bypass: true } }),
      app.inject({ method: "GET", url: "/rework-orders/not-a-uuid/own-factory-approval" }),
    ]);
    expect(missingKey.statusCode).toBe(400);
    expect(extraField.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(service.approve).not.toHaveBeenCalled();
    expect(service.reject).not.toHaveBeenCalled();
    expect(service.get).not.toHaveBeenCalled();
    await app.close();
  });
});
