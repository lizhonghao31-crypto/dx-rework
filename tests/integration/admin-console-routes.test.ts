import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import type { AdminConsoleService } from "../../apps/api/src/admin-console-service.js";

const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost/test", DINGTALK_CORP_ID: "corp", DINGTALK_H5_APP_KEY: "key", DINGTALK_H5_APP_SECRET: "secret", DINGTALK_WEB_CLIENT_ID: "web", DINGTALK_WEB_CLIENT_SECRET: "secret", DINGTALK_QR_REDIRECT_URI: "https://example.test/callback", SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters" });
const actorId = randomUUID();
const attachmentId = randomUUID();
const delegationId = randomUUID();
const sourceId = randomUUID();

function appFor(capabilities: string[], businessRoles: string[], isRoot = false) {
  const service = {
    attachments: vi.fn().mockResolvedValue({ items: [{ attachmentId, filename: "evidence.pdf", mimeType: "application/pdf", sizeBytes: "1234567890123", sha256: "a".repeat(64), uploadedBy: actorId, uploaderDisplayName: "Admin", entityType: "wage_adjustment", entityId: "wage-1", status: "ready", rejectionReason: null, createdAt: "2026-08-05T00:00:00.000Z", readyAt: "2026-08-05T00:01:00.000Z" }], nextCursor: null }),
    delegations: vi.fn().mockResolvedValue({ items: [{ delegationId, grantor: { userId: actorId, displayName: "Grantor" }, grantee: { userId: randomUUID(), displayName: "Grantee" }, capability: "process:review", scopeType: "rework_order", scopeId: "order-1", validFrom: "2026-08-01T00:00:00.000Z", validUntil: "2026-08-31T00:00:00.000Z", grantedBy: actorId, grantReason: "休假", createdAt: "2026-08-01T00:00:00.000Z", revokedAt: null, revokedBy: null, revokeReason: null, effectiveNow: true }], nextCursor: null }),
    exceptions: vi.fn().mockResolvedValue({ items: [{ exceptionType: "message_outbox_failed", sourceEntityType: "message_outbox", sourceEntityId: sourceId, status: "failed", occurredAt: "2026-08-05T00:00:00.000Z", lastUpdatedAt: "2026-08-05T00:00:00.000Z", safeError: "[REDACTED]", retryable: true, deepLink: null, details: { version: 1 } }], nextCursor: null }),
    retry: vi.fn().mockResolvedValue({ retried: true, exceptionType: "message_outbox_failed", sourceEntityId: sourceId, operationEventId: randomUUID(), status: "pending" }),
  };
  const root = { isRootUser: vi.fn(async () => isRoot) };
  const app = buildApp({
    config,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    adminConsole: {
      authenticate: vi.fn().mockResolvedValue({ id: actorId, displayName: "Admin", capabilities, businessRoles }),
      service: service as unknown as AdminConsoleService,
      root: root as never,
    },
  });
  return { app, service };
}

describe("admin console routes", () => {
  it("allows system_admin with admin:read to query administrator metadata and parses boolean query strings exactly", async () => {
    const { app, service } = appFor(["admin:read", "admin:exception:manage"], ["system_admin"]);
    expect((await app.inject({ method: "GET", url: `/admin/attachments?attachmentId=${attachmentId}&limit=100` })).statusCode).toBe(200);
    expect(service.attachments).toHaveBeenCalledWith(expect.objectContaining({ attachmentId, limit: 100 }));

    expect((await app.inject({ method: "GET", url: `/admin/delegations?includeRevoked=true&activeAt=2026-08-05T00:00:00.000Z` })).statusCode).toBe(200);
    expect(service.delegations).toHaveBeenLastCalledWith(expect.objectContaining({ includeRevoked: true }));
    expect((await app.inject({ method: "GET", url: "/admin/delegations?includeRevoked=false" })).statusCode).toBe(200);
    expect(service.delegations).toHaveBeenLastCalledWith(expect.objectContaining({ includeRevoked: false }));

    expect((await app.inject({ method: "GET", url: "/admin/exceptions?retryable=true" })).statusCode).toBe(200);
    expect(service.exceptions).toHaveBeenLastCalledWith(expect.objectContaining({ retryable: true }));
    expect((await app.inject({ method: "GET", url: "/admin/exceptions?retryable=false" })).statusCode).toBe(200);
    expect(service.exceptions).toHaveBeenLastCalledWith(expect.objectContaining({ retryable: false }));

    expect((await app.inject({ method: "GET", url: "/admin/delegations?includeRevoked=1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/exceptions?retryable=0" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/attachments?unexpected=true" })).statusCode).toBe(400);
  });

  it("admits root to technical administration without requiring the system_admin role", async () => {
    const { app, service } = appFor([], ["owner_group"], true);
    expect((await app.inject({ method: "GET", url: "/admin/attachments" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin/exceptions" })).statusCode).toBe(200);
    expect(service.attachments).toHaveBeenCalledOnce();
  });

  it.each(["owner_group", "production_management", "tail_supervisor", "finance_read"])("rejects non-root %s from administrator console", async (role) => {
    const { app } = appFor(["dashboard:management:read", "report:view"], [role], false);
    expect((await app.inject({ method: "GET", url: "/admin/attachments" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/delegations" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/exceptions" })).statusCode).toBe(403);
  });

  it("does not expose administrator attachment mutation or delegation mutation routes", async () => {
    const { app } = appFor(["admin:read"], ["system_admin"]);
    expect((await app.inject({ method: "DELETE", url: `/admin/attachments/${attachmentId}` })).statusCode).toBe(403);
    expect((await app.inject({ method: "PATCH", url: `/admin/attachments/${attachmentId}`, payload: { status: "ready" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url: "/admin/delegations", payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ method: "DELETE", url: `/admin/delegations/${delegationId}` })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: `/admin/attachments/${attachmentId}/download` })).statusCode).toBe(403);
  });

  it("requires admin:exception:manage and Idempotency-Key for retry", async () => {
    const { app, service } = appFor(["admin:read", "admin:exception:manage"], ["system_admin"]);
    expect((await app.inject({ method: "POST", url: `/admin/exceptions/message_outbox_failed/${sourceId}/retry`, payload: { expectedVersion: 1, reason: "retry technical task" } })).statusCode).toBe(400);
    expect((await app.inject({ method: "POST", url: `/admin/exceptions/message_outbox_failed/${sourceId}/retry`, headers: { "idempotency-key": "retry-1" }, payload: { expectedVersion: 1, reason: "retry technical task" } })).statusCode).toBe(200);
    expect(service.retry).toHaveBeenCalledWith(expect.objectContaining({ actorId, authorizationCapability: "admin:exception:manage" }), "message_outbox_failed", sourceId, { expectedVersion: 1, reason: "retry technical task" }, "retry-1");
  });
});