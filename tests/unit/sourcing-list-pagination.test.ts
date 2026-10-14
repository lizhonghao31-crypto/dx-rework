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

const row = (index: number, totalCount = 16) => ({
  total_count: String(totalCount),
  total_order_quantity: String(totalCount * 100),
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
  it("returns true 15-row numbered pages and the total page count", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({rows:[{relation:null}]})
      .mockResolvedValueOnce({ rows: Array.from({ length: 15 }, (_, index) => row(index + 1)) })
      .mockResolvedValueOnce({rows:[{relation:null}]})
      .mockResolvedValueOnce({ rows: [row(16)] });
    const service = new SourcingService({ query } as unknown as Pool);

    const first = await service.listCases(actor, "", "pending", 1);
    expect(first.items).toHaveLength(15);
    expect(first).toMatchObject({ page: 1, pageSize: 15, totalCount: 16, totalPages: 2 });
    expect(first.totalOrderQuantity).toBe(1600);
    expect(query.mock.calls[1]?.[0]).toContain("LIMIT 15 OFFSET $7");
    expect(query.mock.calls[1]?.[0]).toContain(
      "ORDER BY created_at DESC,sourcing_case_id DESC",
    );
    expect(query.mock.calls[1]?.[1]).toEqual(["", "pending", "all", "all", "", null, 0]);

    const second = await service.listCases(actor, "", "pending", 2);
    expect(second.items).toHaveLength(1);
    expect(second.totalOrderQuantity).toBe(1600);
    expect(second).toMatchObject({ page: 2, pageSize: 15, totalCount: 16, totalPages: 2 });
    expect(query.mock.calls[3]?.[1]).toEqual(["", "pending", "all", "all", "", null, 15]);
  });

  it("rejects invalid page numbers before querying PostgreSQL", async () => {
    const query = vi.fn();
    const service = new SourcingService({ query } as unknown as Pool);

    await expect(service.listCases(actor, "", "all", 0)).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns the order's first ready image and merchandiser in the existing paginated list", async () => {
    const firstImage = "00000000-0000-4000-8000-000000000099";
    const query = vi.fn().mockResolvedValueOnce({rows:[{relation:null}]}).mockResolvedValue({ rows: [{ ...row(1, 1), merchandiser_name: "原跟单/协同跟单", first_image_attachment_id: firstImage }] });
    const service = new SourcingService({ query } as unknown as Pool);

    const result = await service.listCases(actor, "", "pending", 1);
    expect(result.items[0]).toMatchObject({ merchandiserName: "原跟单/协同跟单", firstImageAttachmentId: firstImage });
    expect(query.mock.calls[1]?.[0]).toContain("concat_ws('/',creator_user.display_name,additional_user.display_name) AS merchandiser_name");
    expect(query.mock.calls[1]?.[0]).toContain("LEFT JOIN app_users additional_user");
    expect(query.mock.calls[1]?.[0]).toContain("image.entity_id=case_view.sourcing_case_id::text");
    expect(query.mock.calls[1]?.[0]).toContain("image.status='ready'");
    expect(query.mock.calls[1]?.[0]).toContain("ORDER BY image.created_at,image.attachment_id LIMIT 1");
  });
  it("retains full totals on an empty out-of-range page and returns zero for no matches", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sourcing_case_id: null, total_count: "16", total_order_quantity: "1600" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ sourcing_case_id: null, total_count: "0", total_order_quantity: "0" }] });
    const service = new SourcingService({ query } as unknown as Pool);
    expect(await service.listCases(actor, "", "pending", 3)).toMatchObject({ items: [], totalCount: 16, totalOrderQuantity: 1600, totalPages: 2 });
    expect(await service.listCases(actor, "not found")).toMatchObject({ items: [], totalCount: 0, totalOrderQuantity: 0 });
  });

  it("does not query or expose summary without the existing read capability", async () => {
    const query = vi.fn();
    const service = new SourcingService({ query } as unknown as Pool);
    await expect(service.listCases({ ...actor, authorizationCapabilities: [] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(query).not.toHaveBeenCalled();
  });

});
