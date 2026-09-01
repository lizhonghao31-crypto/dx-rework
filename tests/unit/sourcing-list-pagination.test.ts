import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor: TrustedActorContext = {
  actorId: "00000000-0000-4000-8000-000000000001",
  actorRoles: ["order_merchandiser"],
  authorizationCapability: "sourcing:view",
  authorizationCapabilities: ["sourcing:view"],
  requestId: "sourcing-list-pagination",
};

const row = (index: number) => ({
  sourcing_case_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  erp_order_id: `ERP-${index}`,
  erp_order_no: `ERP-${index}`,
  style_no: `STYLE-${index}`,
  lane_key: "garment_processing",
  order_quantity: 100,
  delivery_date: "2026-09-30",
  process_description: "整烫",
  process_items: ["整烫"],
  status: "pending_ie_quote",
  version: 1,
  created_by: actor.actorId,
  created_at: new Date(Date.UTC(2026, 8, 30, 0, 0, 30 - index)),
  updated_at: new Date(Date.UTC(2026, 8, 30, 0, 0, 30 - index)),
  sourcing_ie_quote_id: null,
  quote_version: null,
  unit_price: null,
  quote_quantity: null,
  total_amount: null,
  quote_reason: null,
  quoted_by: null,
  quoted_at: null,
  sourcing_decision_id: null,
  decision_version: null,
  source_type: null,
  source_ie_quote_id: null,
  supersedes_decision_id: null,
  supplier_id: null,
  supplier_code_snapshot: null,
  supplier_name_snapshot: null,
  decision_unit_price: null,
  decision_quantity: null,
  decision_total_amount: null,
  management_decision_reason: null,
  management_decided_by: null,
  management_decided_at: null,
  sourcing_owner_decision_id: null,
  owner_sourcing_decision_id: null,
  owner_decision: null,
  owner_decision_reason: null,
  owner_decided_by: null,
  owner_decided_at: null,
});

describe("sourcing list pagination", () => {
  it("returns 15 rows and uses a stable cursor for the next query", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: Array.from({ length: 16 }, (_, index) => row(index + 1)) })
      .mockResolvedValueOnce({ rows: [row(16)] });
    const service = new SourcingService({ query } as unknown as Pool);

    const first = await service.listCases(actor, "", "pending");
    expect(first.items).toHaveLength(15);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(query.mock.calls[0]?.[0]).toContain("LIMIT 16");
    expect(query.mock.calls[0]?.[0]).toContain(
      "ORDER BY case_view.created_at DESC,case_view.sourcing_case_id DESC",
    );

    const second = await service.listCases(actor, "", "pending", first.nextCursor ?? "");
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(query.mock.calls[1]?.[1]).toEqual([
      "",
      "pending",
      row(15).created_at.toISOString(),
      row(15).sourcing_case_id,
    ]);
  });

  it("rejects malformed cursors before querying PostgreSQL", async () => {
    const query = vi.fn();
    const service = new SourcingService({ query } as unknown as Pool);

    await expect(service.listCases(actor, "", "all", "not-a-cursor")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });
});
