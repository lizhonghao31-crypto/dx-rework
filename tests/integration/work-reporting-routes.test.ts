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
const apps: FastifyInstance[] = [];
const orderId = "00000000-0000-4000-8000-000000000010";
const taskId = "00000000-0000-4000-8000-000000000011";

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const create = (
  businessRoles: readonly string[],
  capabilities: readonly string[],
) => {
  const service = {
    list: vi.fn(async () => ({ reworkOrderId: orderId, reworkStatus: "in_progress", orderVersion: 2, tasks: [] })),
    listAssignablePeople: vi.fn(async () => [{ personId: "00000000-0000-4000-8000-000000000013", displayName: "可上数工人", personType: "internal" as const }]),
    createTask: vi.fn(),
    submitReport: vi.fn(async (_actor, submittedTaskId) => ({
      value: {
        workReportId: "00000000-0000-4000-8000-000000000012",
        workTaskId: submittedTaskId,
        reworkOrderId: orderId,
        actualQuantity: 1,
        completedAt: "2026-08-02T12:00:00.000Z",
        status: "submitted" as const,
        groupAmount: null,
        memberShares: [{ personId: "00000000-0000-4000-8000-000000000013", amount: 1 }],
      },
      reused: false,
    })),
  };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    workReporting: {
      authenticate: async (token) => {
        if (token !== "trusted") throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
        return { id: "00000000-0000-4000-8000-000000000001", displayName: "兼任主管", businessRoles, capabilities };
      },
      service: service as never,
    },
  });
  apps.push(app);
  return { app, service };
};

describe("work reporting routes", () => {
  it("exposes only server-filtered assignees to a supervisor", async () => {
    const { app, service } = create(["tail_supervisor"], ["work:assign"]);
    const response = await app.inject({ method: "GET", url: "/work-task-options", headers: { cookie: "dx_rework_session=trusted" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ people: [{ personId: "00000000-0000-4000-8000-000000000013", displayName: "可上数工人", personType: "internal" }] });
    expect(service.listAssignablePeople).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "work:assign" }));
  });

  it("passes both report capabilities to the service for task-specific authorization", async () => {
    const { app, service } = create(
      ["tail_supervisor", "worker"],
      ["work:assign", "work:report", "work:report_for_worker"],
    );
    const response = await app.inject({
      method: "POST",
      url: `/work-tasks/${taskId}/reports`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "proxy-report-1" },
      payload: { expectedOrderVersion: 2, actualQuantity: 1, completedAt: "2026-08-02T12:00:00.000Z" },
    });

    expect(response.statusCode).toBe(201);
    expect(service.submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor", "worker"],
        authorizationCapability: "work:report",
        authorizationCapabilities: ["work:assign", "work:report", "work:report_for_worker"],
      }),
      taskId,
      expect.objectContaining({ actualQuantity: 1 }),
      "proxy-report-1",
    );
  });

  it("honors delegated proxy-report capability for an authorized non-supervisor", async () => {
    const { app, service } = create(["order_merchandiser"], ["work:report_for_worker"]);
    const response = await app.inject({
      method: "POST",
      url: `/work-tasks/${taskId}/reports`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "delegated-proxy-report-1" },
      payload: { expectedOrderVersion: 2, actualQuantity: 1, completedAt: "2026-08-02T12:00:00.000Z" },
    });

    expect(response.statusCode).toBe(201);
    expect(service.submitReport).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["order_merchandiser"],
        authorizationCapability: "work:report_for_worker",
        authorizationCapabilities: ["work:report_for_worker"],
      }),
      taskId,
      expect.objectContaining({ actualQuantity: 1 }),
      "delegated-proxy-report-1",
    );
  });
});
