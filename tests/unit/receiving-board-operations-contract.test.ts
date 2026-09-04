import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("receiving board operations", () => {
  it("exports the complete current filter as a two-sheet workbook", async () => {
    const [routes, service, page] = await Promise.all([
      read("apps/api/src/receiving/receiving-routes.ts"),
      read("apps/api/src/receiving/receiving-service.ts"),
      read("apps/web/src/order-board-page.tsx"),
    ]);
    expect(routes).toContain('"/receiving/board/export"');
    expect(routes).toContain('name: "订单汇总"');
    expect(routes).toContain('name: "收货明细"');
    expect(service).toContain("pageSizeInput = 15");
    expect(service).toContain("50_001");
    expect(service).toContain("导出订单超过50000条");
    expect(page.indexOf("order-board-export")).toBeLessThan(page.indexOf("开始日期"));
    expect(page).toContain("URL.createObjectURL(await response.blob())");
  });

  it("keeps packing and both difference resolutions audited and immutable", async () => {
    const [migration, routes, service] = await Promise.all([
      read("apps/api/migrations/0139_receiving_packing_difference_resolution.sql"),
      read("apps/api/src/receiving/receiving-routes.ts"),
      read("apps/api/src/receiving/receiving-service.ts"),
    ]);
    expect(migration).toContain("CREATE TABLE receiving_packing_revisions");
    expect(migration).toContain("CREATE TABLE receiving_difference_resolutions");
    expect(migration).toContain("receiving_packing_revisions_no_update");
    expect(migration).toContain("receiving_difference_resolutions_no_delete");
    expect(routes).toContain('"/receiving/batches/:receivingBatchId/packing-revisions"');
    expect(routes).toContain('"/receiving/batches/:receivingBatchId/difference-resolutions"');
    expect(service).toContain("receiving:resolve_difference");
    expect(service).toContain("receiving:packing_manage");
    expect(service).toContain("订单数量已变化，请刷新或搜索款号后再处理");
    expect(service).toContain("difference_quantity_snapshot");
  });

  it("shows a compact operations band and prevents four-digit history collisions", async () => {
    const [page, css] = await Promise.all([
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/order-board-page.css"),
    ]);
    for (const label of ["收货差异", "装箱数量", "装箱差异", "去处理", "已处理"]) {
      expect(page).toContain(label);
    }
    expect(page).toContain("本次送货单");
    expect(page).toContain("本次实收");
    expect(page).toContain("alertInApp(text, { title: \"提交失败\" })");
    expect(css).toContain(".order-board-row__operations");
    expect(css).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
    expect(page).toContain("<span>本次送货单 <strong>{quantity(item.receiptDocumentQuantity)}件</strong></span>");
    expect(css).toContain("min-width:0");
  });
});
