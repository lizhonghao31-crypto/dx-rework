import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("v1 prelaunch mobile filters and final order detail UI", () => {
  it("keeps the phone order filters compact without nesting a second input frame", async () => {
    const [page, styles] = await Promise.all([
      readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8"),
      readFile("apps/web/src/reporting/rework-query-mobile.css", "utf8"),
    ]);
    expect(page).toContain('className="reporting-filters reporting-filters--orders"');
    expect(page).toContain('className="reporting-date-range"');
    expect(page).toContain('className="reporting-filters__refresh"');
    expect(page).toContain("刷新</Button>");
    expect(styles).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
    expect(styles).toContain(".reporting-filters--orders .dx-field__control input");
    expect(styles).toContain("min-height:0;max-height:none;padding:0;border:0");
    expect(styles).toContain(".reporting-filters--orders .reporting-filters__refresh{grid-column:3;width:auto");
  });

  it("reads receiving totals and immutable supply snapshots in the business detail query", async () => {
    const service = await readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8");
    expect(service).toContain("sum(receipt.actual_quantity)+batch.actual_quantity_adjustment");
    expect(service).toContain("batch.receiving_batch_id=orders.source_receiving_batch_id");
    expect(service).toContain("LEFT JOIN rework_order_supply_context supply_context");
    expect(service).toContain("washing_supplier.supplier_name washing_supplier_name");
    expect(service).toContain("embroidery_supplier.supplier_name embroidery_supplier_name");
    expect(service).toContain("fabric_supplier.supplier_name fabric_supplier_name");
    expect(service).toContain("embroidery_merchandiser.display_name embroidery_merchandiser_name");
  });
});
