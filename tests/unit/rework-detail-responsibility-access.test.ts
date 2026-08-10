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

  it("keeps pre-0044 orders readable while optional initiation fields are unavailable", async () => {
    const service = await readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8");

    expect(service).toContain("to_jsonb(orders)->>'customer_supply_code'");
    expect(service).toContain("to_jsonb(orders)->>'factory_style_no'");
    expect(service).toContain("to_jsonb(orders)->>'order_quantity'");
    expect(service).toContain("to_jsonb(orders)->>'rework_reason'");
    expect(service).toContain("to_jsonb(orders)->>'rework_process'");
    expect(service).toContain("orderQuantity: row.order_quantity === null ? null : Number(row.order_quantity)");
    expect(service).toContain("attachment.entity_id=$1::text");
    expect(service).toContain("external_case.rework_order_id=$1::uuid");
  });
});
