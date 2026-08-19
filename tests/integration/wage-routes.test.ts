import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import type { WageItem, WagePeriod, WagePeriodDetail } from "@dx-rework/contracts/wages";
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
};

const period: WagePeriod = {
  periodId: ids.period,
  periodMonth: "2026-07-01",
  timezone: "Asia/Singapore",
  status: "ready_to_lock",
  periodVersion: 2,
  sourceItemCount: 1,
  personCount: 1,
  totalAmount: "1.00",
  lockedBy: null,
  lockedAt: null,
  lockNote: null,
  canLock: true,
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
  supplierNameSnapshot: "本厂",
  temporaryWageMultiplier: "1.000",
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
  memberSnapshot: [{ personId: ids.person, displayName: "Worker", personType: "internal" }],
};

const detail: WagePeriodDetail = { period, items: [item] };
const user = {
  id: ids.actor,
  businessRoles: ["wage_month_close_accountant"],
  capabilities: ["wage:view", "wage:month_close", "wage:export"],
};

function buildService() {
  return {
    list: vi.fn().mockResolvedValue([period]),
    get: vi.fn().mockResolvedValue(detail),
    item: vi.fn().mockResolvedValue(item),
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
  it("returns direct-month-close period, detail, item and XLSX responses", async () => {
    const { app, service, exportService } = buildTestApp();
    const [listed, loaded, items, loadedItem, exported] = await Promise.all([
      app.inject({ method: "GET", url: "/wage-periods" }),
      app.inject({ method: "GET", url: `/wage-periods/${ids.period}` }),
      app.inject({ method: "GET", url: `/wage-periods/${ids.period}/items` }),
      app.inject({ method: "GET", url: `/wage-items/${ids.item}` }),
      app.inject({ method: "GET", url: `/wage-periods/${ids.period}/export.xlsx` }),
    ]);
    expect(listed.statusCode).toBe(200);
    expect(listed.json()[0]).toMatchObject({ periodId: ids.period, status: "ready_to_lock", totalAmount: "1.00" });
    expect(loaded.json()).toEqual(detail);
    expect(items.json()).toEqual([item]);
    expect(loadedItem.json()).toEqual(item);
    expect(exported.statusCode).toBe(200);
    expect(exported.headers["content-type"]).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "wage:view" }));
    expect(exportService.export).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "wage:export" }),
      ids.period,
    );
    await app.close();
  });

  it("passes the exact version and idempotency key only to month close", async () => {
    const { app, service } = buildTestApp();
    const locked = await app.inject({
      method: "POST",
      url: `/wage-periods/${ids.period}/lock`,
      headers: { "idempotency-key": "month-close" },
      payload: { expectedVersion: 2, lockNote: "月结" },
    });
    expect(locked.statusCode).toBe(200);
    expect(service.lock).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "wage:month_close" }),
      ids.period,
      2,
      "月结",
      "month-close",
    );
    await app.close();
  });

  it("does not expose retired wage review or adjustment endpoints", async () => {
    const { app } = buildTestApp();
    const retired = await Promise.all([
      app.inject({ method: "POST", url: `/wage-periods/${ids.period}/tail-approve`, headers: { "idempotency-key": "x1" }, payload: { expectedVersion: 2 } }),
      app.inject({ method: "POST", url: `/wage-periods/${ids.period}/administrative-approve`, headers: { "idempotency-key": "x2" }, payload: { expectedVersion: 2 } }),
      app.inject({ method: "POST", url: `/wage-periods/${ids.period}/administrative-return`, headers: { "idempotency-key": "x3" }, payload: { expectedVersion: 2, reason: "x" } }),
      app.inject({ method: "POST", url: "/wage-adjustments", headers: { "idempotency-key": "x4" }, payload: {} }),
      app.inject({ method: "POST", url: `/wage-adjustments/${randomUUID()}/approve`, headers: { "idempotency-key": "x5" }, payload: {} }),
      app.inject({ method: "POST", url: `/wage-adjustments/${randomUUID()}/reject`, headers: { "idempotency-key": "x6" }, payload: {} }),
    ]);
    for (const response of retired) expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("rejects missing idempotency, extra lock fields and malformed UUIDs", async () => {
    const { app, service } = buildTestApp();
    const [missingKey, widened, malformed] = await Promise.all([
      app.inject({ method: "POST", url: `/wage-periods/${ids.period}/lock`, payload: { expectedVersion: 2, lockNote: null } }),
      app.inject({ method: "POST", url: `/wage-periods/${ids.period}/lock`, headers: { "idempotency-key": "widened" }, payload: { expectedVersion: 2, lockNote: null, bypass: true } }),
      app.inject({ method: "GET", url: "/wage-items/not-a-uuid" }),
    ]);
    expect(missingKey.statusCode).toBe(400);
    expect(widened.statusCode).toBe(400);
    expect(malformed.statusCode).toBe(400);
    expect(service.lock).not.toHaveBeenCalled();
    expect(service.item).not.toHaveBeenCalled();
    await app.close();
  });
});
