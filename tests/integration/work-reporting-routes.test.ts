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
const migratedTailPersonId = "850e82b5-fc66-94fd-203f-a708fe72a9d0";

afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

const create = (
  businessRoles: readonly string[],
  capabilities: readonly string[],
  rootUser = false,
) => {
  const service = {
    list: vi.fn(async () => ({ reworkOrderId: orderId, reworkStatus: "in_progress", orderVersion: 2, tasks: [] })),
    listAssignablePeople: vi.fn(async () => [{ personId: migratedTailPersonId, displayName: "尾查人员", personType: "internal" as const, eligibleExecutionKinds: ["tail_inspection"] as const }]),
    createTask: vi.fn(),
    addActiveTaskMembers: vi.fn(async (_actor, submittedOrderId, input) => ({
      value: { reworkOrderId: submittedOrderId, reworkStatus: "in_progress" as const, orderVersion: input.expectedOrderVersion + 1, tasks: [] },
      reused: false,
    })),
    removeActiveTask: vi.fn(async (_actor, submittedOrderId, _taskId, input) => ({
      value: { reworkOrderId: submittedOrderId, reworkStatus: "in_progress" as const, orderVersion: input.expectedOrderVersion + 1, tasks: [] },
      reused: false,
    })),
    completeExecution: vi.fn(async (_actor, submittedOrderId, input) => ({
      value: { reworkOrderId: submittedOrderId, reworkStatus: "pending_order_review" as const, orderVersion: input.expectedOrderVersion + 1, tasks: [] },
      reused: false,
    })),
    submitReport: vi.fn(async (_actor, submittedTaskId) => ({
      value: {
        workReportId: "00000000-0000-4000-8000-000000000012",
        workTaskId: submittedTaskId,
        reworkOrderId: orderId,
        actualQuantity: 1,
        completedAt: "2026-08-02T12:00:00.000Z",
        status: "submitted" as const,
        groupAmount: null,
        memberShares: [{ personId: migratedTailPersonId, amount: 1 }],
      },
      reused: false,
    })),
    submitReportsBatch: vi.fn(async (_actor, submittedOrderId, input) => ({
      value: {
        reworkOrderId: submittedOrderId,
        reworkStatus: "pending_order_review" as const,
        orderVersion: input.expectedOrderVersion + 1,
        reports: input.reports.map((report, index) => ({
          workReportId: `10000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
          workTaskId: report.workTaskId,
          reworkOrderId: submittedOrderId,
          actualQuantity: report.actualQuantity,
          completedAt: "2026-08-02T12:00:00.000Z",
          status: "submitted" as const,
          groupAmount: 0,
          memberShares: [{
            personId: index === 23 || index === 37
              ? migratedTailPersonId
              : "00000000-0000-4000-8000-000000000013",
            amount: 0,
          }],
        })),
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
      ...(rootUser ? { root: { isRootUser: async () => true } as never } : {}),
    },
  });
  apps.push(app);
  return { app, service };
};

describe("work reporting routes", () => {
  it("allows ordinary IE to read execution facts without granting reporting or assignment", async () => {
    const { app, service } = create(["ie_reviewer"], ["process:review"]);
    const headers = { cookie: "dx_rework_session=trusted", "idempotency-key": "ie-read-only" };
    const response = await app.inject({ method: "GET", url: `/rework-orders/${orderId}/work-tasks`, headers });
    expect(response.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({
      actorRoles: ["ie_reviewer"], authorizationCapability: "process:review",
      authorizationCapabilities: ["process:review"],
    }), orderId);
    for (const url of ["/work-task-options", `/rework-orders/${orderId}/work-tasks`, `/work-tasks/${taskId}/reports`, `/rework-orders/${orderId}/work-tasks/add-members`]) {
      const rejected = await app.inject({ method: url === "/work-task-options" ? "GET" : "POST", url, headers, ...(url !== "/work-task-options" ? { payload: { expectedOrderVersion: 2, actualQuantity: 1, completedAt: "2026-10-11T00:00:00.000Z" } } : {}) });
      expect(rejected.statusCode).toBe(403);
    }
    expect(service.createTask).not.toHaveBeenCalled();
    expect(service.submitReport).not.toHaveBeenCalled();
    expect(service.addActiveTaskMembers).not.toHaveBeenCalled();
  });

  it("preserves Root execution reads without an IE role", async () => {
    const { app, service } = create([], [], true);
    const response = await app.inject({ method: "GET", url: `/rework-orders/${orderId}/work-tasks`, headers: { cookie: "dx_rework_session=trusted" } });
    expect(response.statusCode).toBe(200);
    expect(service.list).toHaveBeenCalledWith(expect.objectContaining({ actorRoles: expect.arrayContaining(["root_superuser"]) }), orderId);
  });

  it.each([
    { roles: ["ie_reviewer"], capabilities: [] },
    { roles: ["quality_control"], capabilities: ["process:review"] },
  ])("rejects execution reads without both IE role and review capability: $roles", async ({ roles, capabilities }) => {
    const { app, service } = create(roles, capabilities);
    const response = await app.inject({ method: "GET", url: `/rework-orders/${orderId}/work-tasks`, headers: { cookie: "dx_rework_session=trusted" } });
    expect(response.statusCode).toBe(403);
    expect(service.list).not.toHaveBeenCalled();
  });

  it("returns a migration-0079 tail inspector instead of failing the whole personnel response", async () => {
    const { app, service } = create(["tail_supervisor"], ["work:assign"]);
    const response = await app.inject({ method: "GET", url: "/work-task-options", headers: { cookie: "dx_rework_session=trusted" } });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ people: [{ personId: migratedTailPersonId, displayName: "尾查人员", personType: "internal", eligibleExecutionKinds: ["tail_inspection"] }] });
    expect(service.listAssignablePeople).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "work:assign" }));
  });

  it.each([
    { role: "tail_supervisor", label: "尾部主管" },
    { role: "owner_group", label: "老板" },
  ])("allows $label to add employees during active execution", async ({ role }) => {
    const { app, service } = create([role], ["work:assignment_adjust"]);
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-tasks/add-members`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": `active-add-${role}` },
      payload: {
        expectedOrderVersion: 2,
        configurationItemId: taskId,
        memberIds: [taskId],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.addActiveTaskMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: [role],
        authorizationCapability: "work:assignment_adjust",
      }),
      orderId,
      expect.objectContaining({ memberIds: [taskId] }),
      `active-add-${role}`,
    );
  });

  it("allows an owner to remove an unreported active employee task", async () => {
    const { app, service } = create(["owner_group"], ["work:assignment_adjust"]);
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-tasks/${taskId}/remove-active`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "active-remove-owner" },
      payload: { expectedOrderVersion: 2 },
    });

    expect(response.statusCode).toBe(200);
    expect(service.removeActiveTask).toHaveBeenCalledWith(
      expect.objectContaining({ actorRoles: ["owner_group"], authorizationCapability: "work:assignment_adjust" }),
      orderId,
      taskId,
      { expectedOrderVersion: 2 },
      "active-remove-owner",
    );
  });

  it("allows Root to adjust active employees without a business-role grant", async () => {
    const { app, service } = create([], [], true);
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-tasks/add-members`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "active-add-root" },
      payload: {
        expectedOrderVersion: 2,
        configurationItemId: taskId,
        memberIds: [taskId],
      },
    });

    expect(response.statusCode).toBe(201);
    expect(service.addActiveTaskMembers).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: expect.arrayContaining(["root_superuser"]),
        authorizationCapability: "work:assignment_adjust",
      }),
      orderId,
      expect.any(Object),
      "active-add-root",
    );
  });

  it.each([
    ["production_management"],
    ["quality_control"],
    ["worker"],
    ["order_merchandiser"],
  ])("rejects active workforce adjustment for %s even if the capability is present", async (role) => {
    const { app, service } = create([role], ["work:assignment_adjust"]);
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-tasks/add-members`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": `active-add-denied-${role}` },
      payload: {
        expectedOrderVersion: 2,
        configurationItemId: taskId,
        memberIds: [taskId],
      },
    });

    expect(response.statusCode).toBe(403);
    expect(service.addActiveTaskMembers).not.toHaveBeenCalled();
  });

  it("allows the tail supervisor to recover an all-reported N04 order", async () => {
    const { app, service } = create(["tail_supervisor"], ["work:assign"]);
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-tasks/complete`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "complete-reported-n04" },
      payload: { expectedOrderVersion: 2 },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ reworkStatus: "pending_order_review", orderVersion: 3 });
    expect(service.completeExecution).toHaveBeenCalledWith(
      expect.objectContaining({ actorRoles: ["tail_supervisor"], authorizationCapability: "work:assign" }),
      orderId,
      { expectedOrderVersion: 2 },
      "complete-reported-n04",
    );
  });

  it("rejects N04 completion recovery for an unrelated role", async () => {
    const { app, service } = create(["worker"], ["work:report", "work:assign"]);
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-tasks/complete`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "complete-reported-denied" },
      payload: { expectedOrderVersion: 2 },
    });
    expect(response.statusCode).toBe(403);
    expect(service.completeExecution).not.toHaveBeenCalled();
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

  it("submits a 50-item proxy-report payload through one atomic batch service call", async () => {
    const { app, service } = create(
      ["tail_supervisor", "worker"],
      ["work:assign", "work:report", "work:report_for_worker"],
    );
    const reports = Array.from({ length: 50 }, (_, index) => ({
      workTaskId: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      actualQuantity: 5_000 + index,
    }));
    const response = await app.inject({
      method: "POST",
      url: `/rework-orders/${orderId}/work-reports/batch`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "proxy-report-batch-50" },
      payload: { expectedOrderVersion: 2, reports },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({
      reworkOrderId: orderId,
      reworkStatus: "pending_order_review",
      orderVersion: 3,
    });
    expect(response.json().reports).toHaveLength(50);
    expect(response.json().reports[23].memberShares[0].personId).toBe(migratedTailPersonId);
    expect(response.json().reports[37].memberShares[0].personId).toBe(migratedTailPersonId);
    expect(service.submitReportsBatch).toHaveBeenCalledTimes(1);
    expect(service.submitReportsBatch).toHaveBeenCalledWith(
      expect.objectContaining({
        actorRoles: ["tail_supervisor", "worker"],
        authorizationCapability: "work:report",
        authorizationCapabilities: ["work:assign", "work:report", "work:report_for_worker"],
      }),
      orderId,
      { expectedOrderVersion: 2, reports },
      "proxy-report-batch-50",
    );
    expect(service.submitReport).not.toHaveBeenCalled();
  });

  it("rejects work-report quantities beyond one decimal place", async () => {
    const { app, service } = create(["worker"], ["work:report"]);
    const response = await app.inject({
      method: "POST",
      url: `/work-tasks/${taskId}/reports`,
      headers: { cookie: "dx_rework_session=trusted", "idempotency-key": "precision-report-1" },
      payload: { expectedOrderVersion: 2, actualQuantity: 1.25, completedAt: "2026-08-02T12:00:00.000Z" },
    });

    expect(response.statusCode).toBe(400);
    expect(service.submitReport).not.toHaveBeenCalled();
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
