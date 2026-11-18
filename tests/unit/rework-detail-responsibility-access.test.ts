import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ReworkBusinessDetailService } from "../../apps/api/src/rework/rework-business-detail-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

describe("rework business detail responsibility access", () => {
  it("lets an order-scoped delegated responsibility handler open the N07 detail deep link", async () => {
    const migration = await readFile("apps/api/migrations/0010_responsibility_determination_amount_engine.sql", "utf8");
    expect(migration).toContain("d.grantee_user_id=candidate AND d.capability='responsibility:determine'");
    expect(migration).toContain("d.scope_type='rework_order' AND d.scope_id=order_id::text");

    const actor: TrustedActorContext = {actorId: "11111111-1111-4111-8111-111111111111", actorRoles: [],
      authorizationCapability: "responsibility:determine", requestId: "TEST delegated responsibility read"};
    const delegatedOrder = "22222222-2222-4222-8222-222222222222", unrelatedOrder = "33333333-3333-4333-8333-333333333333";
    const subject = (id: string) => ({rework_order_id: id, created_by: null, merchandiser_user_id: null, embroidery_merchandiser_user_id: null});
    const query = vi.fn(async (sql: string, [actorId, scope]: [string, string[]]) => {
      expect(sql).toContain("FROM unnest($2::uuid[]) scoped(rework_order_id)");
      expect(sql).toContain("responsibility_can_determine($1,scoped.rework_order_id)");
      expect(actorId).toEqual(actor.actorId);
      return {rows: scope.includes(delegatedOrder) ? [{rework_order_id: delegatedOrder}] : []};
    });
    const service = new ReworkBusinessDetailService({query} as unknown as Pool);
    await expect(service.canViewExistingBusinessDetails(actor,subject(delegatedOrder))).resolves.toBe(true);
    await expect(service.canViewExistingBusinessDetails(actor,subject(unrelatedOrder))).resolves.toBe(false);
    expect(query.mock.calls.map(([, values]) => values[1])).toEqual([[delegatedOrder], [unrelatedOrder]]);
    await expect(service.canViewExistingBusinessDetails({...actor, authorizationCapability: "rework:view"},subject(delegatedOrder))).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
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
