import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import type { TailInspectionResponse } from "@dx-rework/contracts";
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

const orderId = "00000000-0000-4000-8000-000000000010";
const assignmentId = "00000000-0000-4000-8000-000000000011";
const inspectorId = "00000000-0000-4000-8000-000000000012";
const itemId = "00000000-0000-4000-8000-000000000013";
const response: TailInspectionResponse = {
  reworkOrderId: orderId,
  reworkStatus: "pending_ie_review",
  assignments: [{
    assignmentId,
    tailInspectorUserId: inspectorId,
    tailInspectorName: "尾查甲",
    boxScope: null,
    status: "active",
    returnedQuantity: null,
    submittedAt: null,
    canSubmit: true,
  }],
  processes: [{ configurationItemId: itemId, processName: "车缝返修", inspectedQuantity: 0 }],
};

const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const create = (businessRoles: readonly string[], capabilities: readonly string[]) => {
  const service = {
    listOptions: vi.fn(async () => ({ inspectors: [{ userId: inspectorId, displayName: "尾查甲" }] })),
    get: vi.fn(async () => response),
    submit: vi.fn(async () => ({ value: response, reused: false })),
  };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    tailInspection: {
      authenticate: async (token) => {
        if (token === undefined) throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return { id: inspectorId, displayName: "尾查甲", businessRoles, capabilities };
      },
      service: service as never,
    },
  });
  apps.push(app);
  return { app, service };
};

describe("tail inspection routes", () => {
  it("keeps assigning inspectors with the tail supervisor", async () => {
    const { app, service } = create(["tail_supervisor"], ["process:configure"]);
    const result = await app.inject({ method: "GET", url: "/tail-inspection-options", headers: { cookie: "dx_rework_session=trusted" } });
    expect(result.statusCode).toBe(200);
    expect(service.listOptions).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "process:configure" }));
  });

  it("lets only the tail inspector submit an integer, per-process count", async () => {
    const { app, service } = create(["tail_inspector"], ["tail_inspection:report"]);
    const result = await app.inject({
      method: "POST",
      url: `/tail-inspection-assignments/${assignmentId}/reports`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "tail-report-1" },
      payload: { returnedQuantity: 20, items: [{ configurationItemId: itemId, inspectedQuantity: 20 }] },
    });
    expect(result.statusCode).toBe(201);
    expect(service.submit).toHaveBeenCalledWith(
      expect.objectContaining({ actorRoles: ["tail_inspector"], authorizationCapability: "tail_inspection:report" }),
      assignmentId,
      { returnedQuantity: 20, items: [{ configurationItemId: itemId, inspectedQuantity: 20 }] },
      "tail-report-1",
    );

    const invalid = await app.inject({
      method: "POST",
      url: `/tail-inspection-assignments/${assignmentId}/reports`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "tail-report-2" },
      payload: { returnedQuantity: 20, items: [{ configurationItemId: itemId, inspectedQuantity: 21 }] },
    });
    expect(invalid.statusCode).toBe(400);
  });
});
