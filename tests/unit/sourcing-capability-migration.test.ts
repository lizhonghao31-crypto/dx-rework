import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("0096 sourcing view capability migration", () => {
  it("is additive, idempotent and grants exactly the approved roles", async () => {
    const sql = await readFile("apps/api/migrations/0096_sourcing_view_capability.sql", "utf8");
    const grants = [...sql.matchAll(/\('([^']+)','sourcing:view'\)/g)].map((match) => match[1]);
    expect(grants).toEqual([
      "production_management",
      "order_merchandiser",
      "factory_payables",
      "finance_director",
      "owner_group",
    ]);
    expect(sql).toContain("ON CONFLICT (capability) DO NOTHING");
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toMatch(/DELETE|UPDATE\s+(?:capability_catalog|role_capabilities)/i);
  });

  it("adds IE workbench view access without rewriting the applied 0096 migration", async () => {
    const sql = await readFile("apps/api/migrations/0098_sourcing_ie_view_grant.sql", "utf8");
    const grants = [...sql.matchAll(/\('([^']+)','sourcing:view'\)/g)].map((match) => match[1]);
    expect(grants).toEqual(["ie_reviewer"]);
    expect(sql).toContain("ON CONFLICT DO NOTHING");
    expect(sql).not.toMatch(/DELETE|UPDATE\s+(?:capability_catalog|role_capabilities)/i);
  });
});
