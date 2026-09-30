import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import { buildApp } from "../../apps/api/src/app.js";
import { AuthDeniedError } from "../../apps/api/src/auth/service.js";

const config = loadConfig({
  NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost/test", DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "key", DINGTALK_H5_APP_SECRET: "secret", DINGTALK_WEB_CLIENT_ID: "web",
  DINGTALK_WEB_CLIENT_SECRET: "secret", DINGTALK_QR_REDIRECT_URI: "https://example.test/callback",
  SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters",
});
const apps: FastifyInstance[] = [];
const orderId = "00000000-0000-4000-8000-000000000010";
const reportId = "00000000-0000-4000-8000-000000000011";
const response = {
  reworkOrderId: orderId, reworkStatus: "pending_order_review", orderVersion: 2,
  canReview: true, canIeReview: false, unifiedExecutionRequired: true,
  canAdjustQuantity: false, canConfirmQuantity: false, canReviewQuantityIncrease: false,
  processes: [], reports: [], adjustments: [], temporaryWorkers: [], reviewId: null,
  finalConfirmation: null,
};

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const create = (businessRoles: readonly string[] = ["tail_supervisor"], capabilities: readonly string[] = ["submission:audit"]) => {
  const service = {
    get: vi.fn(async () => response), approve: vi.fn(async () => ({ value: response, reused: false })),
    rejectReport: vi.fn(async () => ({ value: response, reused: false })),
    correctReportQuantity: vi.fn(async () => ({ value: response, reused: false })),
  };
  const app = buildApp({
    config, checkDatabase: async () => undefined, getAppliedSchemaHistory: async () => null,
    wholeOrderReview: {
      authenticate: async (token) => {
        if (token !== "trusted") throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return { id: "00000000-0000-4000-8000-000000000001", displayName: "李同生", businessRoles, capabilities };
      }, service: service as never,
    },
  });
  apps.push(app);
  return { app, service };
};

describe("whole order review routes", () => {
  it("passes the complete session capability snapshot to server-side scoped authorization", async () => {
    const { app, service } = create(["order_merchandiser"], ["quantity:confirm"]);
    const result = await app.inject({ method: "GET", url: "/rework-orders/" + orderId + "/whole-order-review", headers: { cookie: "dx_rework_session=trusted" } });
    expect(result.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith(expect.objectContaining({ actorRoles: ["order_merchandiser"], authorizationCapabilities: ["quantity:confirm"] }), orderId);
  });

  it("passes the optional process scope to the service without widening the response", async () => {
    const { app, service } = create(["quality_control"], ["quantity:adjust"]);
    const result = await app.inject({ method: "GET", url: "/rework-orders/" + orderId + "/whole-order-review?configurationItemId=" + reportId, headers: { cookie: "dx_rework_session=trusted" } });
    expect(result.statusCode).toBe(200);
    expect(service.get).toHaveBeenCalledWith(expect.any(Object), orderId, reportId);
  });

  it("requires idempotency and validates a targeted rejection before service execution", async () => {
    const { app, service } = create();
    const invalid = await app.inject({ method: "POST", url: "/work-reports/" + reportId + "/reject", headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "reject-1" }, payload: { expectedOrderVersion: 2, rejectedPersonId: orderId, reason: " " } });
    expect(invalid.statusCode).toBe(400);
    expect(service.rejectReport).not.toHaveBeenCalled();
    const valid = await app.inject({ method: "POST", url: "/work-reports/" + reportId + "/reject", headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "reject-2" }, payload: { expectedOrderVersion: 2, rejectedPersonId: orderId, reason: "漏检" } });
    expect(valid.statusCode).toBe(200);
    expect(service.rejectReport).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "submission:audit" }), reportId, expect.objectContaining({ reason: "漏检" }), "reject-2");
  });

  it("accepts a positive integer effective quantity and delegates with tail audit authority", async () => {
    const { app, service } = create();
    const invalid = await app.inject({
      method: "POST",
      url: "/work-reports/" + reportId + "/effective-quantity",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "correct-1" },
      payload: { expectedOrderVersion: 2, effectiveQuantity: 4800.5 },
    });
    expect(invalid.statusCode).toBe(400);
    expect(service.correctReportQuantity).not.toHaveBeenCalled();

    const valid = await app.inject({
      method: "POST",
      url: "/work-reports/" + reportId + "/effective-quantity",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "correct-2" },
      payload: { expectedOrderVersion: 2, effectiveQuantity: 4800 },
    });
    expect(valid.statusCode).toBe(200);
    expect(service.correctReportQuantity).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "submission:audit" }),
      reportId,
      { expectedOrderVersion: 2, effectiveQuantity: 4800 },
      "correct-2",
    );
  });

  it("does not expose retired quantity-adjustment mutations", async () => {
    const { app } = create();
    const result = await app.inject({ method: "POST", url: "/rework-orders/" + orderId + "/quantity-adjustments/decrease", headers: { "idempotency-key": "decrease-1" }, payload: { expectedOrderVersion: 2, configurationItemId: reportId, newPlannedQuantity: 1, reason: "实裁" } });
    expect(result.statusCode).toBe(404);
  });
});

