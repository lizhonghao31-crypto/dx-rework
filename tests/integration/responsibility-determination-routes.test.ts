import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import type { ResponsibilityDeterminationResponse } from "@dx-rework/contracts";
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
const determinationId = randomUUID();
const configurationItemId = randomUUID();
const actorId = randomUUID();

const response: ResponsibilityDeterminationResponse = {
  reworkOrderId: orderId,
  reworkStatus: "pending_responsibility_determination",
  orderVersion: 8,
  handlerUserId: actorId,
  canDetermine: true,
  canTakeover: false,
  canConfirmHighMultiplier: false,
  sourceProcesses: [
    {
      configurationItemId,
      processName: "返查",
      pricingUnit: "piece",
      baseAmount: "154.55000000",
    },
  ],
  determination: {
    determinationId,
    version: 1,
    stage: "draft",
    reason: null,
    calculationTotal: "185.46",
    highMultiplierConfirmed: false,
    processes: [
      {
        configurationItemId,
        processName: "返查",
        pricingUnit: "piece",
        multiplier: "1.200",
        highMultiplierReason: null,
        baseAmount: "154.55000000",
        responsibilityAmount: "185.46",
        allocations: [
          {
            responsibilityType: "own_factory",
            shareBps: 10000,
            roundedAmount: "185.46",
          },
        ],
      },
    ],
  },
};

const user = {
  id: actorId,
  businessRoles: ["production_management", "owner_group"],
  capabilities: [
    "responsibility:determine",
    "responsibility:takeover",
    "responsibility:confirm_high_multiplier",
  ],
};

const draftBody = {
  expectedOrderVersion: 7,
  expectedCurrentDeterminationVersion: null,
  handlerUserId: actorId,
  processes: [
    {
      configurationItemId,
      multiplier: "1.200",
      allocations: [
        { responsibilityType: "own_factory", shareBps: 10000 },
      ],
    },
  ],
};

function buildService() {
  return {
    get: vi.fn().mockResolvedValue(response),
    saveDraft: vi.fn().mockResolvedValue({ value: response, reused: false }),
    finalize: vi.fn().mockResolvedValue({ value: response, reused: false }),
    transfer: vi.fn().mockResolvedValue({ value: response, reused: false }),
    takeover: vi.fn().mockResolvedValue({ value: response, reused: false }),
    confirmHighMultiplier: vi
      .fn()
      .mockResolvedValue({ value: response, reused: false }),
  };
}

function buildTestApp(service = buildService()) {
  const authenticate = vi.fn().mockResolvedValue(user);
  const app = buildApp({
    config: testConfig,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    responsibilityDetermination: { authenticate, service },
  });
  return { app, service, authenticate };
}

describe("responsibility routes", () => {
  it("serves the authorized GET response for the concrete order", async () => {
    const { app, service } = buildTestApp();
    const result = await app.inject({
      method: "GET",
      url: `/rework-orders/${orderId}/responsibility-determination`,
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toEqual(response);
    expect(service.get).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId,
        authorizationCapability: "responsibility:determine",
      }),
      orderId,
    );
    await app.close();
  });

  it("saves a draft with strict body parsing and idempotency", async () => {
    const { app, service } = buildTestApp();
    const result = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/responsibility-determinations/drafts`,
      headers: { "idempotency-key": "route-draft" },
      payload: draftBody,
    });
    expect(result.statusCode).toBe(201);
    expect(service.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "responsibility:determine" }),
      orderId,
      draftBody,
      "route-draft",
    );
    await app.close();
  });

  it("finalizes the exact current determination version", async () => {
    const { app, service } = buildTestApp();
    const payload = {
      expectedOrderVersion: 8,
      expectedCurrentDeterminationVersion: 1,
    };
    const result = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/responsibility-determinations/finalize`,
      headers: { "idempotency-key": "route-finalize" },
      payload,
    });
    expect(result.statusCode).toBe(200);
    expect(service.finalize).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "responsibility:determine" }),
      orderId,
      payload,
      "route-finalize",
    );
    await app.close();
  });

  it("transfers to the requested eligible handler", async () => {
    const { app, service } = buildTestApp();
    const toUserId = randomUUID();
    const payload = {
      expectedOrderVersion: 8,
      expectedCurrentDeterminationVersion: 1,
      toUserId,
      reason: "当班交接",
    };
    const result = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/responsibility-determinations/transfer`,
      headers: { "idempotency-key": "route-transfer" },
      payload,
    });
    expect(result.statusCode).toBe(200);
    expect(service.transfer).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "responsibility:determine" }),
      orderId,
      payload,
      "route-transfer",
    );
    await app.close();
  });

  it("uses the takeover capability for the owner takeover route", async () => {
    const { app, service } = buildTestApp();
    const payload = {
      expectedOrderVersion: 8,
      expectedCurrentDeterminationVersion: 1,
      reason: "老板介入处理",
    };
    const result = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/responsibility-determinations/takeover`,
      headers: { "idempotency-key": "route-takeover" },
      payload,
    });
    expect(result.statusCode).toBe(200);
    expect(service.takeover).toHaveBeenCalledWith(
      expect.objectContaining({ authorizationCapability: "responsibility:takeover" }),
      orderId,
      payload,
      "route-takeover",
    );
    await app.close();
  });

  it("uses the confirmation capability for a concrete determination", async () => {
    const { app, service } = buildTestApp();
    const payload = {
      expectedOrderVersion: 8,
      expectedCurrentDeterminationVersion: 1,
      reason: "独立复核高倍率",
    };
    const result = await app.inject({
      method: "POST",
      url: `/responsibility-determinations/${determinationId}/high-multiplier-confirm`,
      headers: { "idempotency-key": "route-confirm" },
      payload,
    });
    expect(result.statusCode).toBe(200);
    expect(service.confirmHighMultiplier).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "responsibility:confirm_high_multiplier",
      }),
      determinationId,
      payload,
      "route-confirm",
    );
    await app.close();
  });

  it.each([
    `/rework-orders/${orderId}/responsibility-determinations/drafts`,
    `/rework-orders/${orderId}/responsibility-determinations/finalize`,
    `/rework-orders/${orderId}/responsibility-determinations/transfer`,
    `/rework-orders/${orderId}/responsibility-determinations/takeover`,
    `/responsibility-determinations/${determinationId}/high-multiplier-confirm`,
  ])("rejects writes without an idempotency key: %s", async (url) => {
    const { app } = buildTestApp();
    const result = await app.inject({ method: "POST", url, payload: {} });
    expect(result.statusCode).toBe(400);
    await app.close();
  });

  it("rejects malformed order identifiers before calling the service", async () => {
    const { app, service } = buildTestApp();
    const result = await app.inject({
      method: "GET",
      url: "/rework-orders/not-a-uuid/responsibility-determination",
    });
    expect(result.statusCode).toBe(400);
    expect(service.get).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects extra fields instead of silently accepting a wider command", async () => {
    const { app, service } = buildTestApp();
    const result = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/responsibility-determinations/drafts`,
      headers: { "idempotency-key": "route-extra" },
      payload: { ...draftBody, bypassAuthorization: true },
    });
    expect(result.statusCode).toBe(400);
    expect(service.saveDraft).not.toHaveBeenCalled();
    await app.close();
  });
});
