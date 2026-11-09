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
    expect(routes).toContain("row.defectiveQuantity,row.differenceQuantity");
  });

  it("keeps packing and both difference resolutions audited and immutable", async () => {
    const [migration, correctiveMigration, routes, service] = await Promise.all([
      read("apps/api/migrations/0139_receiving_packing_difference_resolution.sql"),
      read("apps/api/migrations/0140_receiving_packing_difference_direction.sql"),
      read("apps/api/src/receiving/receiving-routes.ts"),
      read("apps/api/src/receiving/receiving-service.ts"),
    ]);
    const boardRead = await readFile("apps/api/src/receiving/receiving-board-query.ts", "utf8");
    expect(service).toContain("readReceivingBoard");

    expect(migration).toContain("CREATE TABLE receiving_packing_revisions");
    expect(migration).toContain("CREATE TABLE receiving_difference_resolutions");
    expect(migration).toContain("receiving_packing_revisions_no_update");
    expect(migration).toContain("receiving_difference_resolutions_no_delete");
    expect(routes).toContain('"/receiving/batches/:receivingBatchId/packing-revisions"');
    expect(routes).toContain('"/receiving/batches/:receivingBatchId/difference-resolutions"');
    expect(service).toContain("receiving:resolve_difference");
    expect(service).toContain("receiving:packing_manage");
    expect(service).toContain("订单数量已变化，本次未覆盖");
    expect(service).toContain("重新读取累计收货数");
    expect(service).toContain("difference_quantity_snapshot");
    expect(migration).toContain("('warehouse_receiver','receiving:export')");
    expect(migration).toContain("('production_management','receiving:export')");
    expect(migration).toContain("('owner_group','receiving:export')");
    expect(migration).not.toContain("WHERE capability='tools:user'");
    expect(migration).not.toContain("('worker','receiving:export')");
    expect(correctiveMigration).toContain("difference_quantity_snapshot=packing_quantity_snapshot-actual_quantity_snapshot");
    expect(service).toContain("snapshot.packingQuantity! - snapshot.actualQuantity");
    expect(boardRead).toContain("Number(row.packing_quantity) - Number(row.cumulative_actual_quantity)");
  });

  it("shows the confirmed two-layer facts and confirmation ownership", async () => {
    const [page, css] = await Promise.all([
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/order-board-page.css"),
    ]);
    for (const label of ["收货差异", "装箱数量", "装箱差异", "去处理", "已处理"]) {
      expect(page).toContain(label);
    }
    expect(page).toContain("本次送货单");
    expect(page).toContain("本次实收");
    expect(page).toContain('className="order-board-dialog__error" role="alert"');
    expect(page).not.toContain("alertInApp(text, { title: \"提交失败\" })");
    const main = page.slice(page.indexOf('<div className="order-board-row__main">'), page.indexOf('<div className="order-board-row__facts">'));
    const facts = page.slice(page.indexOf('<div className="order-board-row__facts">'), page.indexOf("</Surface>", page.indexOf('<div className="order-board-row__facts">')));
    const fieldOrder = ["实裁数", "送货单数量", "实收", "次品", "收货差异", "装箱数量", "装箱差异"];
    fieldOrder.slice(1).forEach((label, index) => {
      expect(facts.indexOf(fieldOrder[index]!)).toBeLessThan(facts.indexOf(label));
    });
    expect(main.indexOf("<span>裁床登记人</span>")).toBeLessThan(main.indexOf("<span>收货人</span>"));
    expect(main.indexOf("<span>收货人</span>")).toBeLessThan(main.indexOf("<span>装箱确认人</span>"));
    expect(main.indexOf("<span>装箱确认人</span>")).toBeLessThan(main.indexOf("{actionControls(row, false)}"));
    expect(page).not.toContain('<div className="order-board-row__confirmation">');
    expect(page).toContain('row.actualCutCount === null ? "—"');
    expect(page).toContain("row.cuttingRecordedBy && row.cuttingRecordedAt");
    expect(page).toContain("row.lastReceiverName} · {dateTime(row.lastReceivedAt)");
    expect(page).toContain("row.packingRecordedBy && row.packingRecordedAt");
    expect(css).toContain("grid-template-columns:minmax(220px,1.35fr) repeat(3,minmax(150px,1fr)) minmax(190px,auto)");
    expect(css).toContain(".order-board-row__main>.order-board-row__cutting-confirmation{grid-column:2}");
    expect(css).toContain(".order-board-row__main>.order-board-row__receiving-confirmation{grid-column:3}");
    expect(css).toContain(".order-board-row__main>.order-board-row__packing-confirmation{grid-column:4}");
    expect(css).toContain(".order-board-row__main>.order-board-actions--desktop{grid-column:5;padding-right:10px}");
    expect(css).toContain(".order-board-row__facts{grid-template-columns:repeat(7,minmax(0,1fr))}");
    expect(css).toContain("@container (max-width:839px)");
    expect(css).toContain(".order-board-row__packing-difference{grid-column:span 2}");
    expect(css).toContain(".order-board-row__facts>div{display:grid;align-content:center;justify-items:center;gap:0;min-width:0;min-height:34px;padding:2px 8px");
    expect(css).toContain(".order-board-row__main>.order-board-row__confirmation-item{display:flex;align-items:center;justify-content:center");
    expect(css).not.toContain(".order-board-row__confirmation-item{display:flex;align-self:stretch");
    expect(css).not.toContain("order-board-row__confirmation-item{display:flex;align-items:center;justify-content:center;gap:6px;min-width:0;border-left");
    expect(css).toContain(".order-board-operation-button,.order-board-packing-button{flex:0 0 auto;min-height:20px");
    expect(css).toContain("font-family:inherit;font-size:10px;font-weight:700;line-height:1");
    expect(css).not.toContain("font:800 7px/1 inherit");
    expect(css).toContain(".order-board-history__entry>button{justify-self:end;width:max-content;min-width:max-content;white-space:nowrap");
    expect(page).toContain('>{row.packingQuantity === null ? "录入" : "修改"}</button>');
    expect(page).toContain("<span>本次送货单 <strong>{quantity(item.receiptDocumentQuantity)}件</strong></span>");
    expect(page).toContain("const liveOperationSnapshot = searchMode || endDate >= localDate()");
    expect(page).toContain("canManagePacking && liveOperationSnapshot");
    expect(page).toContain("canHandle && !liveOperationSnapshot ? <small>历史只读</small>");
    expect(css).toContain("min-width:0");
  });
});
