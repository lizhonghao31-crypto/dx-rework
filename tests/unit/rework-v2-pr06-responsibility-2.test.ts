import { readFile } from "node:fs/promises";

import { ResponsibilityProcessInputSchema } from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

const own = {
  responsibilityType: "own_factory" as const,
  shareBps: 7000,
  multiplier: "1.000",
};
const external = {
  responsibilityType: "processing_factory" as const,
  shareBps: 3000,
  multiplier: "1.200",
  supplierId: "11111111-1111-4111-8111-111111111111",
};

describe("PR-06 responsibility 2.0", () => {
  it("accepts multiple positive responsibility shares totaling 100 percent", () => {
    expect(ResponsibilityProcessInputSchema.parse({
      configurationItemId: "22222222-2222-4222-8222-222222222222",
      multiplier: "1.000",
      allocations: [own, external],
    }).allocations).toHaveLength(2);
  });

  it("rejects incomplete totals, zero shares, and duplicate responsibility types", () => {
    const base = {
      configurationItemId: "22222222-2222-4222-8222-222222222222",
      multiplier: "1.000",
    };
    expect(ResponsibilityProcessInputSchema.safeParse({
      ...base,
      allocations: [own, { ...external, shareBps: 2000 }],
    }).success).toBe(false);
    expect(ResponsibilityProcessInputSchema.safeParse({
      ...base,
      allocations: [{ ...own, shareBps: 0 }, { ...external, shareBps: 10000 }],
    }).success).toBe(false);
    expect(ResponsibilityProcessInputSchema.safeParse({
      ...base,
      allocations: [own, { ...own, shareBps: 3000 }],
    }).success).toBe(false);
  });

  it("routes only own-factory responsibility to owner confirmation", async () => {
    const [service, migration, panel] = await Promise.all([
      readFile("apps/api/src/rework/responsibility-determination-authorized-service.ts", "utf8"),
      readFile("apps/api/migrations/0081_rework_v2_responsibility_2.sql", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
    ]);
    expect(service).toContain("const requiresOwnerSignature = current.settlement_schema_version === 2 && hasOwnFactory");
    expect(service).toContain("await this.externalResponsibilities.ensureForFinalized(client, actor, order, id)");
    expect(service).toContain("await maybeCompleteResponsibilityAction(client, actor, actionOrder)");
    expect(migration).toContain("WHEN 'rework.responsibility.submit_owner_signature'");
    expect(migration).toContain("THEN 'rework.responsibility.finalize'");
    expect(migration).toContain("CREATE CONSTRAINT TRIGGER responsibility_allocation_total_deferred");
    expect(migration).toContain("DEFERRABLE INITIALLY DEFERRED");
    expect(migration).toContain("total_share<>10000");
    expect(panel).toContain("跳过老板确认");
    expect(panel).toContain("生成供应商扣款台账");
  });

  it("excludes temporary-worker wage uplift from the responsibility base", async () => {
    const engine = await readFile("apps/api/src/rework/responsibility-determination-service.ts", "utf8");
    expect(engine).toContain("wage.actual_quantity_snapshot*wage.unit_price_snapshot");
    expect(engine).toContain("1::numeric/NULLIF(wage.member_count,0)");
    expect(engine).not.toContain("wage.payable_amount::text amount");
  });
});
