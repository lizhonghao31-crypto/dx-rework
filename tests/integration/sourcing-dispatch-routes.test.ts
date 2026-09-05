import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerSourcingRoutes } from "../../apps/api/src/sourcing/sourcing-routes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map((app) => app.close())); });
const caseId = randomUUID();
const documentId = randomUUID();
const userId = randomUUID();
const order = {
  productionOrderId: randomUUID(), sourcingCaseId: caseId, decisionVersion: 1, sourceCaseArchived: false,
  sourcingContractDocumentId: documentId, contractNumber: "DX-WF-20260905-000001", contractVersion: 1,
  supplierId: randomUUID(), supplierName: "测试加工厂", gender: "男装", styleName: "长裤", quantity: 100,
  processes: ["车缝"], deliveryDate: "2026-10-20", firstStyleNo: "DX-01", dispatchedBy: userId,
  dispatchedAt: new Date().toISOString(), status: "in_production", firstReportedOn: null,
  reportingState: "pending_first_report", timeProgress: null, progressAlert: null,
  lines: [{ position: 1, styleNo: "DX-01", alternateStyleNo: null, color: "蓝色", quantity: 100 }],
};
const setup = (roles: string[], capabilities: string[], root = false) => {
  const production = { dispatch: vi.fn(async () => ({ value: order, statusCode: 201, reused: false })) };
  const app = Fastify(); apps.push(app);
  registerSourcingRoutes(app, {
    authenticate: async () => ({ id: userId, displayName: "测试", businessRoles: roles, capabilities }),
    root: { isRootUser: async () => root } as never,
    service: {} as never, production: production as never,
  });
  return { app, production };
};
const request = (payload: unknown = { sourcingContractDocumentId: documentId, confirmed: true }) => ({
  method: "POST" as const, url: `/sourcing/cases/${caseId}/dispatch`,
  headers: { "idempotency-key": randomUUID() }, payload,
});
describe("SSP-06 dispatch HTTP boundary", () => {
  it("accepts the merchandiser without a finance capability or finance input", async () => {
    const { app, production } = setup(["order_merchandiser"], ["sourcing:view", "sourcing:contract:record"]);
    const result = await app.inject(request());
    expect(result.statusCode).toBe(201);
    expect(production.dispatch).toHaveBeenCalledWith(expect.objectContaining({ actorId: userId,
      authorizationCapability: "sourcing:contract:record" }), caseId,
    { sourcingContractDocumentId: documentId, confirmed: true }, expect.any(String));
    expect(result.json()).not.toHaveProperty("daxingUnitPrice");
  });
  it("keeps Root fallback without assigning Root a new business role", async () => {
    const { app, production } = setup([], [], true);
    expect((await app.inject(request())).statusCode).toBe(201);
    expect(production.dispatch.mock.calls[0]?.[0]).toMatchObject({ actorRoles: expect.arrayContaining(["root_superuser"]) });
  });
  it.each(["factory_payables", "ie_reviewer", "owner_group", "production_management", "warehouse_keeper", "worker"])(
    "does not grant dispatch authority to %s", async (role) => {
      const { app, production } = setup([role], ["sourcing:view", "sourcing:contract:record"]);
      expect((await app.inject(request())).statusCode).toBe(403);
      expect(production.dispatch).not.toHaveBeenCalled();
    },
  );
  it("rejects missing confirmation, price injection and missing idempotency key", async () => {
    const { app, production } = setup(["order_merchandiser"], ["sourcing:contract:record"]);
    for (const payload of [
      { sourcingContractDocumentId: documentId },
      { sourcingContractDocumentId: documentId, confirmed: false },
      { sourcingContractDocumentId: documentId, confirmed: true, daxingUnitPrice: "1.00" },
    ]) expect((await app.inject(request(payload))).statusCode).toBe(400);
    expect((await app.inject({ ...request(), headers: {} })).statusCode).toBe(400);
    expect(production.dispatch).not.toHaveBeenCalled();
  });
});
