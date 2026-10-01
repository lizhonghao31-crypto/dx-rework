import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { registerBudgetRoutes } from "../../apps/api/src/production-platform/budget-routes.js";
import { DigitalBudgetService } from "../../apps/api/src/production-platform/budget-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { FakeObjectStorage } from "../../apps/api/src/tools/storage.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

describe("P09 budget HTTP field and attachment boundary", () => {
  const orderId = randomUUID(), designerId = randomUUID(), primaryId = randomUUID(), imageId = randomUUID(), otherId = randomUUID();
  const setup = async (role: string, userId: string) => {
    const mother = { production_order_id: orderId, created_by: designerId, primary_merchandiser_id: primaryId, designer_name: "TEST designer", merchandiser_name: "TEST primary" };
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      const rows = /FROM digital_production_orders/.test(sql) && values?.[0] === orderId ? [mother] : [];
      return { rows, rowCount: rows.length };
    });
    const database = { query } as unknown as Pool;
    const budget = new DigitalBudgetService(database, true), storage = new FakeObjectStorage();
    const attachments = new AttachmentService(database, storage, { prefix: "TEST", ttlSeconds: 60, maxUploadBytes: 1000 });
    const signing = vi.spyOn(storage, "createDownloadGrant"), uploading = vi.spyOn(storage, "createExactSizeNonOverwritableUploadGrant");
    const app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const value = error as ApplicationError;
      reply.code(value.statusCode ?? 500).send({ code: value.code, message: value.message });
    });
    registerBudgetRoutes(app, {
      service: new DigitalProductionIdentityService(database, true), creationEnabled: true,
      authenticate: async token => {
        if (token !== "TEST-session") throw new ApplicationError("UNAUTHORIZED", "请登录", 401);
        return { id: userId, displayName: "TEST", businessRoles: [role], capabilities: [] };
      },
    }, budget, attachments);
    await app.ready();
    return { app, query, signing, uploading };
  };
  const headers = { cookie: "dx_rework_session=TEST-session" };
  const base = `/digital-production/orders/${orderId}/budget`;
  for (const role of ["pattern_room_supervisor", "pattern_room_worker", "quality_control", "warehouse_receiver", "order_merchandiser"]) {
    it(`rejects out-of-scope ${role} for current, historical, print-source, and image access`, async () => {
      const { app, signing, uploading } = await setup(role, otherId);
      try {
        for (const url of [base, `${base}?version=1`, `${base}/attachments/${imageId}`, `${base}/upload-limits`]) {
          expect((await app.inject({ method: "GET", url, headers })).statusCode).toBe(404);
        }
        expect(signing).not.toHaveBeenCalled(); expect(uploading).not.toHaveBeenCalled();
      } finally { await app.close(); }
    });
  }
  it("allows owner designer to edit and primary merchandiser to read, while requiring login", async () => {
    for (const [role, userId, canEdit] of [["sample_designer", designerId, true], ["order_merchandiser", primaryId, false]] as const) {
      const { app } = await setup(role, userId);
      try {
        const response = await app.inject({ method: "GET", url: base, headers });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ productionOrderId: orderId, canEdit, document: null, version: 0 });
        expect((await app.inject({ method: "GET", url: base })).statusCode).toBe(401);
        expect((await app.inject({ method: "GET", url: `${base}?version=-1`, headers })).statusCode).toBe(400);
      } finally { await app.close(); }
    }
  });
});
