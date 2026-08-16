import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import type { ProcessConfigurationResponse } from "@dx-rework/contracts";
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

const response: ProcessConfigurationResponse = {
  reworkOrderId: "00000000-0000-4000-8000-000000000010",
  reworkNo: "RW-2026-0802-001",
  reworkStatus: "pending_process_configuration",
  orderVersion: 2,
  configuration: null,
};

const create = (
  businessRoles: readonly string[] = ["tail_supervisor"],
  capabilities: readonly string[] = ["process:configure"],
) => {
  const service = {
    options: vi.fn(async () => ({ processes: [] })),
    get: vi.fn(async () => response),
    saveDraft: vi.fn(async () => ({ value: response, reused: false })),
    submit: vi.fn(async () => ({ value: { ...response, reworkStatus: "pending_task_assignment" }, reused: false })),
    review: vi.fn(async () => ({ value: { ...response, reworkStatus: "pending_task_assignment" }, reused: false })),
  };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    processConfiguration: {
      authenticate: async (token) => {
        if (token === undefined) throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return {
          id: "00000000-0000-4000-8000-000000000001",
          displayName: "测试人员",
          businessRoles,
          capabilities,
        };
      },
      service: service as never,
    },
  });
  apps.push(app);
  return { app, service };
};

describe("process configuration routes", () => {
  it("limits configuration writes to the tail supervisor and carries idempotency", async () => {
    const { app, service } = create();
    const result = await app.inject({
      method: "PUT",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/draft",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "process-save-1",
        "x-request-id": "process-request-1",
      },
      payload: {
        expectedOrderVersion: 2,
        items: [{
          source: "custom",
          customProcessName: "特殊翻边返修",
          plannedQuantity: 2.1,
          pricingUnit: "piece",
        }],
      },
    });
    expect(result.statusCode).toBe(201);
    expect(service.saveDraft).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor"],
        authorizationCapability: "process:configure",
        requestId: "process-request-1",
      }),
      "00000000-0000-4000-8000-000000000010",
      expect.objectContaining({
        expectedOrderVersion: 2,
        items: [expect.objectContaining({ plannedQuantity: 2.1 })],
      }),
      "process-save-1",
    );
  });

  it("accepts a plan without any price at the HTTP boundary", async () => {
    const { app, service } = create();
    const result = await app.inject({
      method: "PUT",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/draft",
      headers: {
        cookie: "dx_rework_session=trusted",
        "idempotency-key": "process-plan-without-price",
      },
      payload: {
        expectedOrderVersion: 2,
        items: [{
          source: "custom",
          customProcessName: "细分返修",
          plannedQuantity: 2.1,
          pricingUnit: "hour",
        }],
      },
    });

    expect(result.statusCode).toBe(201);
    expect(service.saveDraft).toHaveBeenCalledWith(
      expect.anything(),
      "00000000-0000-4000-8000-000000000010",
      expect.objectContaining({
        items: [expect.not.objectContaining({ unitPrice: expect.anything() })],
      }),
      "process-plan-without-price",
    );
  });

  it("rejects impractical quantity and price precision before calling the service", async () => {
    const { app, service } = create();
    for (const [index, item] of [
      { plannedQuantity: 2.12, unitPrice: 0.55 },
      { plannedQuantity: 2.1, unitPrice: 0.5555 },
      { plannedQuantity: 2.1, unitPrice: 0.0001 },
    ].entries()) {
      const result = await app.inject({
        method: "PUT",
        url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/draft",
        headers: {
          cookie: "dx_rework_session=trusted",
          "idempotency-key": `process-precision-${index}`,
        },
        payload: {
          expectedOrderVersion: 2,
          items: [{
            source: "custom",
            customProcessName: "特殊翻边返修",
            pricingUnit: "hour",
            ...item,
          }],
        },
      });
      expect(result.statusCode).toBe(400);
    }
    expect(service.saveDraft).not.toHaveBeenCalled();
  });

  it("does not let a supervisor impersonate IE review", async () => {
    const { app } = create();
    const result = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/review",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "process-review-1" },
      payload: {
        expectedOrderVersion: 2,
        expectedConfigurationVersion: 1,
        decision: "approved",
      },
    });
    expect(result.statusCode).toBe(403);
  });

  it("requires a reason when IE rejects and accepts the exact IE role/capability pair", async () => {
    const { app, service } = create(["ie_reviewer"], ["process:review"]);
    const missingReason = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/review",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "process-review-2" },
      payload: {
        expectedOrderVersion: 2,
        expectedConfigurationVersion: 1,
        decision: "rejected",
      },
    });
    expect(missingReason.statusCode).toBe(400);

    const accepted = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/review",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "process-review-3" },
      payload: {
        expectedOrderVersion: 2,
        expectedConfigurationVersion: 1,
        decision: "rejected",
        reason: "单价需按实际难度重新核定",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(service.review).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["ie_reviewer"],
        authorizationCapability: "process:review",
      }),
      "00000000-0000-4000-8000-000000000010",
      expect.objectContaining({ decision: "rejected" }),
      "process-review-3",
    );
  });

  it("uses the IE capability for review when a user holds both workstation roles", async () => {
    const { app, service } = create(
      ["tail_supervisor", "ie_reviewer"],
      ["process:configure", "process:review"],
    );
    const result = await app.inject({
      method: "POST",
      url: "/rework-orders/00000000-0000-4000-8000-000000000010/process-configuration/review",
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "process-review-both-roles" },
      payload: {
        expectedOrderVersion: 2,
        expectedConfigurationVersion: 1,
        decision: "approved",
      },
    });

    expect(result.statusCode).toBe(200);
    expect(service.review).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor", "ie_reviewer"],
        authorizationCapability: "process:review",
      }),
      "00000000-0000-4000-8000-000000000010",
      expect.objectContaining({ decision: "approved" }),
      "process-review-both-roles",
    );
  });
});
