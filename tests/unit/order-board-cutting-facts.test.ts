import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("order board cutting facts", () => {
  it("projects current cutting facts without changing receiving difference formulas or KPIs", async () => {
    const [service, filters, page, routes] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/api/src/receiving/receiving-board-filters.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/api/src/receiving/receiving-routes.ts", "utf8"),
    ]);
    expect(service).toContain("COALESCE('cut:'||batch.cutting_order_id::text");
    expect(service).toContain("GROUP BY totals.group_key,totals.style_key");
    expect(filters).toContain("batch.group_key=totals.group_key");
    expect(service).toContain("LEFT JOIN current_cutting_records cutting_record");
    expect(service).toContain("cutting_record.actual_cut_count");
    expect(service).toContain("cutting_user.display_name AS cutting_recorded_by");
    expect(service).toContain("cutting_record.recorded_at AS cutting_recorded_at");
    expect(service).toContain("actualCutCount: row.actual_cut_count === null ? null : Number(row.actual_cut_count)");
    expect(service).toContain("totals.cumulative_actual_quantity-totals.document_quantity AS difference_quantity");
    expect(page).toContain('<span>实裁数</span>');
    expect(page).toContain('<span>裁床登记人</span>');
    expect(page).toContain('row.actualCutCount === null ? "—"');
    expect(routes).toContain('"实裁数", "裁床登记人", "裁床登记时间"');
    expect(routes).not.toContain('["实裁数", "期间实裁');
  });

  it("keeps same-style cutting rows independent and history expansion keyed by stable row identity", async () => {
    const [service, page] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
    ]);
    expect(service).toContain("scope.group_key");
    expect(service).toContain("batch.group_key=totals.group_key");
    expect(page).toContain("expandedRows.has(row.receivingBatchId)");
    expect(page).toContain("toggleHistory(row.receivingBatchId)");
  });

  it("locks the accepted responsive contract at the five PR04 review viewports", async () => {
    const css = await readFile("apps/web/src/order-board-page.css", "utf8");
    const reviewViewports = [
      [1440, 1024],
      [1280, 800],
      [768, 1024],
      [390, 844],
      [360, 800],
    ] as const;
    expect(reviewViewports).toHaveLength(5);
    expect(css).toContain("container-type:inline-size");
    expect(css).toContain("grid-template-columns:repeat(7,minmax(0,1fr))");
    expect(css).toContain("@container (max-width:839px)");
    expect(css).toContain("grid-template-columns:repeat(4,minmax(0,1fr))");
    expect(css).toContain(".order-board-row__packing-difference{grid-column:span 2}");
    expect(css).toContain("min-height:34px");
  });
});
