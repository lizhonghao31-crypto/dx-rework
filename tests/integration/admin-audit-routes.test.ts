import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import type { AdminAuditService } from "../../apps/api/src/admin-audit-service.js";

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

const actorId = randomUUID();
const event = {
  eventId: randomUUID(), requestId: "req", actorId, actorDisplayName: "Admin", actorRoles: ["system_admin"],
  authorizationCapability: "audit:read", action: "x", entityType: "y", entityId: "z", beforeState: null, afterState: null, reason: null, createdAt: "2026-08-05T00:00:00.000Z",
};

function appFor(capabilities: string[], businessRoles: string[]) {
  const service = { events: vi.fn().mockResolvedValue({ items: [event], page: 1, pageSize: 50, totalCount: 1, totalPages: 1 }), exports: vi.fn().mockResolvedValue({ items: [{ ...event, exportType: null, reportType: null }], nextCursor: null }) };
  const app = buildApp({
    config,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    adminAudit: {
      authenticate: vi.fn().mockResolvedValue({ id: actorId, capabilities, businessRoles, displayName: "Admin" }),
      service: service as unknown as AdminAuditService,
    },
  });
  return { app, service };
}

describe("admin audit routes", () => {
  it("allows system_admin with audit:read and rejects unknown query fields", async () => {
    const { app, service } = appFor(["audit:read"], ["system_admin"]);
    expect((await app.inject({ method: "GET", url: "/admin/audit/events?limit=100&actorId=" + actorId })).statusCode).toBe(200);
    expect(service.events).toHaveBeenCalledWith(expect.objectContaining({ limit: 100, actorId }));
    expect((await app.inject({ method: "GET", url: "/admin/audit/events?limit=101" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/admin/audit/exports?unexpected=true" })).statusCode).toBe(400);
  });

  it("allows owner_group to read audit without requiring the technical administrator role", async () => {
    const { app } = appFor(["dashboard:management:read"], ["owner_group"]);
    expect((await app.inject({ method: "GET", url: "/admin/audit/events" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/admin/audit/exports" })).statusCode).toBe(200);
  });

  it.each([
    ["production_management"], ["tail_supervisor"], ["worker"],
  ])("rejects %s even when other business capabilities exist", async (role) => {
    const { app } = appFor(["tools:user", "dashboard:management:read"], [role]);
    expect((await app.inject({ method: "GET", url: "/admin/audit/events" })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/admin/audit/exports" })).statusCode).toBe(403);
  });
});
