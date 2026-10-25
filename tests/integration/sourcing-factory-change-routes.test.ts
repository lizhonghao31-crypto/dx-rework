import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerSourcingRoutes } from "../../apps/api/src/sourcing/sourcing-routes.js";

const apps: FastifyInstance[] = [];
afterEach(async () => { await Promise.all(apps.splice(0).map(app => app.close())); });
const caseId = randomUUID();
const supplierId = randomUUID();
const userId = randomUUID();
const input = { supplierId, unitPrice: "11.3", changeReason: "TEST有效数量转厂" };
const setup = (roles: string[], capabilities: string[], root = false) => {
  const service = { requestFactoryChange: vi.fn(async () => ({
    value: { sourcingCaseId: caseId, orderQuantity: 1000 }, reused: false,
  })) };
  const app = Fastify();
  apps.push(app);
  registerSourcingRoutes(app, {
    authenticate: async () => ({ id: userId, displayName: "TEST", businessRoles: roles, capabilities }),
    root: { isRootUser: async () => root } as never,
    service: service as never,
  });
  return { app, service };
};
const request = (payload: unknown = input) => ({
  method: "POST" as const, url: `/sourcing/cases/${caseId}/factory-changes/owner`,
  headers: { "idempotency-key": randomUUID() }, payload,
});

describe("factory-change HTTP quantity boundary", () => {
  it.each([false, true])("keeps the existing owner route with Root=%s", async root => {
    const { app, service } = setup(root ? [] : ["owner_group"], root ? [] : ["sourcing:owner:approve"], root);
    const response = await app.inject(request());
    expect(response.statusCode).toBe(201);
    expect(service.requestFactoryChange).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: userId, authorizationCapability: "sourcing:owner:approve" }),
      caseId, input, expect.any(String),
    );
    if (root) expect(service.requestFactoryChange.mock.calls[0]?.[0]).toMatchObject({ actorRoles: expect.arrayContaining(["root_superuser"]) });
  });

  it.each([false, true])("rejects quantity, line, or craft edits before the service with Root=%s", async root => {
    const { app, service } = setup(root ? [] : ["owner_group"], root ? [] : ["sourcing:owner:approve"], root);
    for (const extra of [
      { quantity: 200 }, { orderQuantity: 200 }, { proposedQuantity: 200 },
      { craftIds: [randomUUID()] }, { craftNames: ["TEST不能通过转厂改工艺"] },
      { lineItems: [{ position: 1, quantity: 200 }] },
    ]) expect((await app.inject(request({ ...input, ...extra }))).statusCode).toBe(400);
    expect(service.requestFactoryChange).not.toHaveBeenCalled();
  });

  it.each(["factory_payables", "production_management", "system_admin", "director"])(
    "does not grant the owner route to %s merely through a capability", async role => {
      const { app, service } = setup([role], ["sourcing:owner:approve"]);
      expect((await app.inject(request())).statusCode).toBe(403);
      expect(service.requestFactoryChange).not.toHaveBeenCalled();
    },
  );
});
