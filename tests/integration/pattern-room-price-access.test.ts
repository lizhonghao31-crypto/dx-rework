import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { PatternPriceAmountSchema, PatternPriceChangeSchema, patternPriceRoles } from "@dx-rework/contracts/pattern-room";
import { registerPatternRoomPriceRoutes } from "../../apps/api/src/pattern-room/price-routes.js";
import { PatternRoomPriceService, requirePatternPriceAccess } from "../../apps/api/src/pattern-room/price-service.js";
import type { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { canAccessPatternRoomPrices } from "../../apps/web/src/pattern-room-access.js";

const id = randomUUID(), capabilities = Object.keys(patternPriceRoles);
function fixture(roles: string[], root = false) {
  const app = Fastify(), service = { management: vi.fn(async () => ({})), history: vi.fn(async () => []), options: vi.fn(async () => []), quote: vi.fn(async () => ({})), change: vi.fn(async () => ({})) };
  registerPatternRoomPriceRoutes(app, { service: service as unknown as PatternRoomPriceService,
    authenticate: async () => ({ id, businessRoles: roles, capabilities: root ? [] : capabilities }), root: { isRootUser: async () => root } as unknown as RootAuthority });
  return { app, service };
}
describe("pattern room price field permissions", () => {
  it.each([
    ["owner_group", true, true, true, true, true], ["production_management", true, true, false, true, true],
    ["finance_director", true, false, false, true, true], ["pattern_room_supervisor", true, false, false, true, true],
    ["sample_designer", false, false, false, true, true], ["order_merchandiser", false, false, false, false, true],
    ["worker", false, false, false, false, false], ["tail_supervisor", false, false, false, false, false],
    ["finance_read", false, false, false, false, false], ["system_admin", false, false, false, false, false],
  ] as const)("enforces role-specific HTTP and page permissions for %s even with forged extra grants", async (role, read, category, hourly, option, misc) => {
    const { app } = fixture([role]);
    expect(canAccessPatternRoomPrices({ id, displayName: "同名", businessRoles: [role], capabilities })).toBe(read);
    for (const [url, allowed] of [["/pattern-room/prices", read], [`/pattern-room/prices/${id}/history`, read], ["/pattern-room/category-options", option], [`/pattern-room/category-options/${id}/quote`, option], ["/pattern-room/hourly-quote", misc]] as const) {
      expect((await app.inject({ url })).statusCode, url).toBe(allowed ? 200 : 403);
    }
    for (const [url, allowed] of [[`/pattern-room/prices/categories/${id}`, category], ["/pattern-room/prices/hourly", hourly]] as const) {
      expect((await app.inject({ method: "POST", url, payload: { version: 1, amount: "40", enabled: true, reason: "调整" }, headers: { "idempotency-key": randomUUID() } })).statusCode, url).toBe(allowed ? 200 : 403);
    }
    await app.close();
  });
  it("keeps Root and compound role authority", async () => {
    for (const input of [{ roles: [], root: true }, { roles: ["production_management", "owner_group"], root: false }]) {
      const { app } = fixture(input.roles, input.root);
      expect((await app.inject({ method: "POST", url: "/pattern-room/prices/hourly", payload: { version: 1, amount: "18.125", enabled: true, reason: "设置" } })).statusCode).toBe(200);
      await app.close();
    }
  });
  it("does not touch the database when a supervisor directly calls a price write service", async () => {
    const query = vi.fn(), connect = vi.fn(), db = { query, connect } as unknown as Pool;
    const actor = { actorId: id, actorRoles: ["pattern_room_supervisor"], authorizationCapability: "pattern_room:prices:write", authorizationCapabilities: capabilities, requestId: "test" };
    for (const kind of ["category", "hourly"] as const) await expect(new PatternRoomPriceService(db).change(actor, kind, id, { version: 1, amount: "40.000", enabled: true, reason: "试图越权" }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect(query).not.toHaveBeenCalled(); expect(connect).not.toHaveBeenCalled();
    query.mockRejectedValue(Object.assign(new Error("revoked"), { code: "42501" }));
    await expect(requirePatternPriceAccess(db, { ...actor, actorRoles: ["owner_group"] }, "pattern_room:prices:write")).rejects.toMatchObject({ statusCode: 403 });
  });
  it("uses exact three-place decimal input and rejects field injection", () => {
    expect(PatternPriceAmountSchema.parse("18.125")).toBe("18.125");
    expect(PatternPriceAmountSchema.parse("40")).toBe("40.000");
    for (const value of ["18.1251", "-1", "1e3", "NaN", "", "100000000000"]) expect(PatternPriceAmountSchema.safeParse(value).success).toBe(false);
    expect(PatternPriceChangeSchema.safeParse({ version: 1, amount: "10", enabled: true, reason: "调价", hourlyAmount: "99" }).success).toBe(false);
  });
});
