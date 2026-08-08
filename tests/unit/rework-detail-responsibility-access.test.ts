import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework business detail responsibility access", () => {
  it("lets an order-scoped delegated responsibility handler open the N07 detail deep link", async () => {
    const service = await readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8");
    const migration = await readFile("apps/api/migrations/0010_responsibility_determination_amount_engine.sql", "utf8");

    expect(migration).toContain("d.grantee_user_id=candidate AND d.capability='responsibility:determine'");
    expect(migration).toContain("d.scope_type='rework_order' AND d.scope_id=order_id::text");
    expect(service).toContain('actorCapabilities(actor).includes("responsibility:determine")');
    expect(service).toContain("SELECT responsibility_can_determine($1,$2) permitted");
  });
});
