import { afterEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@dx-rework/config";
import type { TodoResponse } from "@dx-rework/contracts";
import type { FastifyInstance } from "fastify";

import { buildApp } from "../../apps/api/src/app.js";

const apps: FastifyInstance[] = [];
const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://user:password@127.0.0.1:5432/dx_rework_test",
  GIT_SHA: "test-sha",
  BUILD_TIME: "2026-08-01T00:00:00.000Z",
  DINGTALK_CORP_ID: "corp-test",
  DINGTALK_H5_APP_KEY: "app-key-test",
  DINGTALK_H5_APP_SECRET: "app-secret-test",
  DINGTALK_WEB_CLIENT_ID: "qr-client-test",
  DINGTALK_WEB_CLIENT_SECRET: "web-client-secret-test",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/auth/qr/callback",
  SESSION_SECRET: "test-session-secret-at-least-32-characters",
});

const todo: TodoResponse = {
  todoId: "00000000-0000-4000-8000-000000000013",
  todoType: "business_action",
  category: "process_configuration",
  sourceEventId: "00000000-0000-4000-8000-000000000014",
  sourceAction: "rework.pending_process_configuration",
  entityType: "rework_order",
  entityId: "00000000-0000-4000-8000-000000000015",
  recipientUserId: "00000000-0000-4000-8000-000000000016",
  requiredRole: "tail_supervisor",
  requiredCapability: "process:configure",
  route: {
    routeName: "process_configuration",
    entityId: "00000000-0000-4000-8000-000000000015",
    todoId: "00000000-0000-4000-8000-000000000013",
  },
  orderContext: {
    reworkNo: "RW-20260801-001",
    orderNo: "PO-2026-001",
    styleNo: "ST-001",
    supplierName: null,
    status: "pending_process_configuration",
    updatedAt: "2026-08-01T00:00:00.000Z",
  },
  policyKey: "general",
  dueAt: "2026-08-02T00:00:00.000Z",
  reminderCount: 0,
  status: "pending",
  blockedReason: null,
  version: 1,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

const createApp = () => {
  const service = {
    listForActor: vi.fn(async () => ({
      todos: [todo],
      nextCursor: null,
      activeModule: "rework" as const,
      moduleCounts: { rework: 1, sourcing: 0, wages: 0 },
    })),
    getForActor: vi.fn(async () => todo),
    latestIndicatorForActor: vi.fn(async () => ({
      latestTodoId: todo.todoId,
      latestReceivedAt: todo.createdAt,
    })),
    listRoutingExceptionsForActor: vi.fn(async () => []),
    transferRoutingException: vi.fn(async () => todo),
  };
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => [],
    todos: {
      authenticate: async (token) => token === "manager"
        ? {
          id: "00000000-0000-4000-8000-000000000017",
          displayName: "manager",
          businessRoles: ["production_management"],
          capabilities: ["todo:view", "todo:routing_exception_manage"],
        }
        : {
          id: "00000000-0000-4000-8000-000000000016",
          displayName: "viewer",
          businessRoles: ["tail_supervisor"],
          capabilities: ["todo:view"],
        },
      service,
    },
  });
  apps.push(app);
  return { app, service };
};

describe("todo HTTP boundaries", () => {
  it("lists only the authenticated actor's own todos through todo:view", async () => {
    const { app, service } = createApp();
    const response = await app.inject({
      method: "GET",
      url: "/todos/mine?module=rework&q=ST-001",
      headers: { cookie: "dx_rework_session=viewer" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      todos: [todo],
      nextCursor: null,
      activeModule: "rework",
      moduleCounts: { rework: 1, sourcing: 0, wages: 0 },
    });
    expect(service.listForActor).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: todo.recipientUserId,
        authorizationCapability: "todo:view",
      }),
      { module: "rework", query: "ST-001", cursor: "" },
    );

    const detail = await app.inject({
      method: "GET",
      url: `/todos/mine/${todo.todoId}`,
      headers: { cookie: "dx_rework_session=viewer" },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toEqual(todo);
    expect(service.getForActor).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: todo.recipientUserId }),
      todo.todoId,
    );

    const indicator = await app.inject({
      method: "GET",
      url: "/todos/mine/indicator",
      headers: { cookie: "dx_rework_session=viewer" },
    });
    expect(indicator.statusCode).toBe(200);
    expect(indicator.headers["x-dx-rework-actor-id"]).toBe(todo.recipientUserId);
    expect(indicator.json()).toEqual({
      latestTodoId: todo.todoId,
      latestReceivedAt: todo.createdAt,
    });
    expect(service.latestIndicatorForActor).toHaveBeenCalledWith(expect.objectContaining({
      actorId: todo.recipientUserId,
      authorizationCapability: "todo:view",
    }));
  });

  it("allows controlled transfer only to direct production management", async () => {
    const { app, service } = createApp();
    const rejected = await app.inject({
      method: "POST",
      url: "/todos/routing-exceptions/00000000-0000-4000-8000-000000000018/transfer",
      headers: { cookie: "dx_rework_session=viewer" },
      payload: { recipientUserId: todo.recipientUserId, reason: "重新核验角色后转交" },
    });
    expect(rejected.statusCode).toBe(403);
    expect(service.transferRoutingException).not.toHaveBeenCalled();

    const accepted = await app.inject({
      method: "POST",
      url: "/todos/routing-exceptions/00000000-0000-4000-8000-000000000018/transfer",
      headers: { cookie: "dx_rework_session=manager" },
      payload: { recipientUserId: todo.recipientUserId, reason: "重新核验角色后转交" },
    });
    expect(accepted.statusCode).toBe(200);
    expect(service.transferRoutingException).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationCapability: "todo:routing_exception_manage",
        actorRoles: ["production_management"],
      }),
      expect.objectContaining({
        routingExceptionId: "00000000-0000-4000-8000-000000000018",
        recipientUserId: todo.recipientUserId,
      }),
    );

    const routingExceptions = await app.inject({
      method: "GET",
      url: "/todos/routing-exceptions/mine",
      headers: { cookie: "dx_rework_session=manager" },
    });
    expect(routingExceptions.statusCode).toBe(200);
    expect(routingExceptions.json()).toEqual({ routingExceptions: [] });
  });
});
