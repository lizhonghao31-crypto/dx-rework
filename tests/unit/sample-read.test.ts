import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { SampleReadQuerySchema } from "../../packages/contracts/src/sample-read.js";
import { SampleCapabilitySchema } from "../../packages/contracts/src/samples.js";
import { sampleReadFilter, SampleReadService } from "../../apps/api/src/samples/sample-read-service.js";
import { registerSampleReadRoutes } from "../../apps/api/src/samples/sample-read-routes.js";
import { canAccessSamples } from "../../apps/web/src/platform-modules.js";
import type { Pool } from "pg";

describe("sample read HTTP and query boundaries", () => {
  const userId = randomUUID();
  const actor = { actorId: userId, actorRoles: ["sample_designer"], authorizationCapability: "sample:view_basic", authorizationCapabilities: ["sample:view_basic"], requestId: "test" };
  it.each([{ page: 0 }, { pageSize: 1000 }, { status: "unknown" }, { disposedFrom: "2026-02-30" }, { disposedFrom: "2026-09-03", disposedTo: "2026-09-01" }, { holderUserId: "同名用户" }])("rejects invalid query %j", value => {
    expect(SampleReadQuerySchema.safeParse(value).success).toBe(false);
  });
  it("binds filters and escapes LIKE wildcard characters", () => {
    const query = SampleReadQuerySchema.parse({ search: "x%' OR true --", brand: "brand'", department: "dept'" });
    const result = sampleReadFilter(actor, query);
    expect(result.where).not.toContain(query.search); expect(result.where).not.toContain(query.brand);
    expect(result.values).toContain("x\\%' OR true --%");
    expect(result.values).toContain("brand'");
  });
  it.each(["sample_designer", "sample_administrative", "sample_finance", "sample_approver", "finance_director", "owner_group"])("requires both role and capability for navigation %s", role => {
    expect(canAccessSamples({ id: userId, displayName: "fixture", businessRoles: [role], capabilities: ["sample:view_basic"] })).toBe(true);
    expect(canAccessSamples({ id: userId, displayName: "fixture", businessRoles: [role], capabilities: [] })).toBe(false);
  });
  it("does not expose sample navigation to technical roles with overbroad capabilities", () => {
    expect(canAccessSamples({ id: userId, displayName: "fixture", businessRoles: ["system_admin"], capabilities: SampleCapabilitySchema.options })).toBe(false);
    expect(canAccessSamples({ id: userId, displayName: "fixture", businessRoles: [], capabilities: [], isRoot: true })).toBe(true);
  });
  it("authenticates every read route and rejects invalid identifiers without a database read", async () => {
    const authenticate = vi.fn(async () => ({ id: userId, displayName: "fixture", businessRoles: ["sample_designer"], capabilities: ["sample:view_basic"] }));
    const app = Fastify();
    registerSampleReadRoutes(app, { authenticate, service: new SampleReadService({} as Pool) });
    for (const path of ["/samples?page=0", "/samples/not-an-id", `/samples/${userId}/history?kind=raw`]) {
      expect((await app.inject({ url: path, headers: { cookie: "dx_rework_session=fixture-session" } })).statusCode).toBe(400);
    }
    expect(authenticate).toHaveBeenCalledTimes(3);
    expect(authenticate).toHaveBeenCalledWith("fixture-session");
    await app.close();
  });
});
