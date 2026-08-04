import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import type {
  WageAdjustment,
  WageItem,
  WagePeriod,
  WagePeriodDetail,
} from "@dx-rework/contracts/wages";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import type { WageExportService } from "../../apps/api/src/wages/wage-export-service.js";
import type { WageService } from "../../apps/api/src/wages/wage-service.js";

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

const ids = {
  actor: randomUUID(),
  period: randomUUID(),
  item: randomUUID(),
  orderReview: randomUUID(),
  order: randomUUID(),
  configuration: randomUUID(),
  task: randomUUID(),
  report: randomUUID(),
  person: randomUUID(),
  adjustment: randomUUID(),
};

const period: WagePeriod = {
  periodId: ids.period,
  periodMonth: "2026-07-01",
  timezone: "Asia/Singapore",
  status: "pending_tail_review",
  periodVersion: 2,
  sourceItemCount: 1,
  personCount: 1,
  originalTotal: "1.00",
  adjustmentTotal: "0.00",
  finalTotal: "1.00",
  lockedBy: null,
  lockedAt: null,
  lockNote: null,
  canTailReview: true,
  canAdministrativeReview: false,
  canLock: false,
  canRequestAdjustment: true,
  canApproveAdjustment: false,
  canExport: true,
};
const item: WageItem = {
  wageItemId: ids.item,
  periodId: ids.period,
  orderReviewId: ids.orderReview,
  reworkOrderId: ids.order,
  configurationItemId: ids.configuration,
  workTaskId: ids.task,
  workReportId: ids.report,
  personId: ids.person,
  personNameSnapshot: "Worker",
  personTypeSnapshot: "internal",
  reworkNoSnapshot: "RW-20260803-001",
  styleNoSnapshot: "STYLE-001",
  processNameSnapshot: "返查",
  pricingUnitSnapshot: "piece",
  unitPriceSnapshot: "1.000",
  actualQuantitySnapshot: "1.00",
  assignmentMode: "individual",
  groupAmount: "1.00000000",
  exactPersonShare: "1.00000000",
  payableAmount: "1.00",
  fractionalRemainder: "0.00000000",
  remainderRank: 1,
  memberCount: 1,
  memberSnapshot: [{
    personId: ids.person,
    displayName: "Worker",
    personType: "internal",
  }],
};
const adjustment: WageAdjustment = {
  adjustmentId: ids.adjustment,
  originalWageItemId: ids.item,
  targetPeriodId: ids.period,
  personId: ids.person,
  adjustmentAmount: "0.01",
  reason: "补差",
  attachmentIds: [],
  status: "pending",
  requestedBy: ids.actor,
  requestedAt: "2026-08-03T00:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  version: 1,
};
const detail: WagePeriodDetail = {
  period,
  items: [item],
  adjustments: [adjustment],
  reviewActions: [],
};
const user = {
  id: ids.actor,
  businessRoles: ["tail_supervisor"],
  capabilities: [
    "wage:view",
    "wage:tail_review",
    "wage:adjustment_request",
    "wage:export",
  ],
};

function buildService() {
  return {
    list: vi.fn().mockResolvedValue([period]),
    get: vi.fn().mockResolvedValue(detail),
    item: vi.fn().mockResolvedValue(item),
    review: vi.fn().mockResolvedValue({ value: period, reused: false }),
    requestAdjustment: vi.fn().mockResolvedValue({
      value: adjustment,
      reused: false,
    }),
    decideAdjustment: vi.fn().mockResolvedValue({
      value: adjustment,
      reused: false,
    }),
    lock: vi.fn().mockResolvedValue({
      value: {
        closureId: randomUUID(),
        periodId: ids.period,
        status: "locked",
        periodVersion: 3,
      },
      reused: false,
    }),
  };
}

function buildTestApp(service = buildService()) {
  const exportService = {
    export: vi.fn().mockResolvedValue({
      filename: "返工工资月结-2026-07.xlsx",
      content: Buffer.from("PK-test"),
    }),
  };
  const app = buildApp({
    config: testConfig,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    wages: {
      authenticate: vi.fn().mockResolvedValue(user),
      service: service as unknown as WageService,
      exportService: exportService as unknown as WageExportService,
    },
  });
  return { app, service, exportService };
}

describe("wage routes", () => {
  it("returns camelCase period, detail, item and XLSX responses", async () => {
    const { app, service, exportService } = buildTestApp();
    const [listed, loaded, items, loadedItem, exported] = await Promise.all([
      app.inject({ method: "GET", url: "/wage-periods" }),
      app.inject({ method: "GET", url: `/wage-periods/${ids.period}` }),
      app.inject({ method: "GET", url: `/wage-periods/${ids.period}/items` }),
      app.inject({ method: "GET", url: `/wage-items/${ids.item}` }),
      app.inject({
        method: "GET",
        url: `/wage-periods/${ids.period}/export.xlsx`,
      }),
    ]);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0]).toMatchObject({
      periodId: ids.period,
      finalTotal: "1.00",
    });
    expect(loaded.json()).toEqual(detail);
    expect(items.json()).toEqual([item]);
    expect(loadedItem.json()).toEqual(item);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({
      actorId: ids.actor,
      authorizationCapability: "wage:view",
    }));
    expect(exportService.export).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "wage:export" }),
      ids.period,
    );
    await app.close();
  });

  it("passes exact versions, actions and idempotency keys", async () => {
    const { app, service } = buildTestApp();
    const [tail, returned, adjustmentResponse, locked] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/wage-periods/${ids.period}/tail-approve`,
        headers: { "idempotency-key": "tail-review" },
        payload: { expectedVersion: 2 },
      }),
      app.inject({
        method: "POST",
        url: `/wage-periods/${ids.period}/administrative-return`,
        headers: { "idempotency-key": "admin-return" },
        payload: { expectedVersion: 2, reason: "重新核对" },
      }),
      app.inject({
        method: "POST",
        url: "/wage-adjustments",
        headers: { "idempotency-key": "adjustment-request" },
        payload: {
          originalWageItemId: ids.item,
          targetPeriodId: ids.period,
          adjustmentAmount: "0.01",
          reason: "补差",
          attachmentIds: [],
          expectedVersion: 2,
        },
      }),
      app.inject({
        method: "POST",
        url: `/wage-periods/${ids.period}/lock`,
        headers: { "idempotency-key": "month-close" },
        payload: { expectedVersion: 2, lockNote: "月结" },
      }),
    ]);
    expect(tail.statusCode).toBe(200);
    expect(returned.statusCode).toBe(200);
    expect(adjustmentResponse.statusCode).toBe(201);
    expect(locked.statusCode).toBe(200);
    expect(service.review).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "wage:tail_review" }),
      ids.period,
      2,
      "tail",
      null,
      "tail-review",
    );
    expect(service.review).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "wage:administrative_review",
      }),
      ids.period,
      2,
      "administrative_return",
      "重新核对",
      "admin-return",
    );
    expect(service.requestAdjustment).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "wage:adjustment_request",
      }),
      expect.objectContaining({ adjustmentAmount: "0.01" }),
      "adjustment-request",
    );
    expect(service.lock).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "wage:month_close" }),
      ids.period,
      2,
      "月结",
      "month-close",
    );
    await app.close();
  });

  it("rejects missing idempotency, extra fields and malformed UUIDs", async () => {
    const { app, service } = buildTestApp();
    const [missingKey, widened, malformed] = await Promise.all([
      app.inject({
        method: "POST",
        url: `/wage-periods/${ids.period}/tail-approve`,
        payload: { expectedVersion: 2 },
      }),
      app.inject({
        method: "POST",
        url: `/wage-periods/${ids.period}/lock`,
        headers: { "idempotency-key": "widened" },
        payload: { expectedVersion: 2, lockNote: null, bypass: true },
      }),
      app.inject({ method: "GET", url: "/wage-items/not-a-uuid" }),
    ]);
    expect(missingKey.statusCode).toBe(400);
    expect(widened.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(service.review).not.toHaveBeenCalled();
    expect(service.lock).not.toHaveBeenCalled();
    expect(service.item).not.toHaveBeenCalled();
    await app.close();
  });
});
