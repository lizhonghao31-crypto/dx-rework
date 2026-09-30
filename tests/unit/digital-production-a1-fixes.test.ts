import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { digitalDateText } from "../../apps/api/src/production-platform/identity-service.js";

describe("digital production A1 fixes", () => {
  it("renders database DATE values as Shanghai business dates", () => {
    expect(digitalDateText(new Date("2026-09-29T16:00:00.000Z"))).toBe("2026-09-30");
    expect(digitalDateText("2026-09-30")).toBe("2026-09-30");
    expect(digitalDateText(null)).toBeNull();
  });

  it("returns the duplicate-color business message from request validation", async () => {
    const createOrder = vi.fn();
    const app = Fastify();
    registerDigitalIdentityRoutes(app, {
      creationEnabled: true,
      authenticate: async () => ({
        id: "11111111-1111-4111-8111-111111111111",
        displayName: "TEST",
        businessRoles: ["sample_designer"],
        capabilities: ["pattern_room:orders:create"],
      }),
      service: { createOrder } as never,
    });
    const response = await app.inject({
      method: "POST",
      url: "/digital-production/orders",
      headers: { cookie: "dx_rework_session=test", "idempotency-key": "TEST-A1-DUPLICATE" },
      payload: {
        customerCode: "PD", productGroup: "男装", designStyleNo: "TEST-A1-DUP",
        orderDate: "2026-09-30", lines: [
          { color: "Blue", sizes: [{ size: "M", quantity: 1 }] },
          { color: " blue ", sizes: [{ size: "L", quantity: 1 }] },
        ],
      },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ message: "同一母单颜色不能重复" });
    expect(createOrder).not.toHaveBeenCalled();
    await app.close();
  });

  it("binds the customer default merchandiser form to persisted customer state", async () => {
    const source = await readFile(new URL("../../apps/web/src/digital-production-access-panel.tsx", import.meta.url), "utf8");
    expect(source).toContain('useState(customers[0]?.defaultMerchandiserId ?? "")');
    expect(source).toContain("value={defaultMerchandiserId}");
    expect(source).toContain('setDefaultMerchandiserId(customer.defaultMerchandiserId ?? "")');
  });

  it("guards legacy todo UUID casts and uses the row todo id as the canonical route id", async () => {
    const source = await readFile(new URL("../../apps/api/src/todos/service.ts", import.meta.url), "utf8");
    expect(source).toContain("todos.entity_id~*'${TODO_ID_SQL_PATTERN}'");
    expect(source).toContain("NULLIF(todos.route_descriptor->>'reworkOrderId','')~*'${TODO_ID_SQL_PATTERN}'");
    expect(source).toContain("TodoRouteDescriptorSchema.parse({ ...row.route_descriptor, todoId: row.todo_id })");
  });
});
