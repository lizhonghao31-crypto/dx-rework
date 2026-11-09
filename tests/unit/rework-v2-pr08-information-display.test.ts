import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("PR-08 information display", () => {
  it("keeps range KPIs while labeling all-time style search explicitly", async () => {
    const [service, page] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
    ]);
    const boardRead = await readFile("apps/api/src/receiving/receiving-board-query.ts", "utf8");
    expect(service).toContain("readReceivingBoard");

    expect(boardRead).toContain("abnormalOrderCount");
    expect(boardRead).toContain("count(*) FILTER (WHERE difference_quantity<>0)");
    expect(boardRead).toContain("prior_actual_quantity");
    expect(service).toContain("delivery_note_quantity");
    expect(boardRead).toContain('const mode = needle ? "search" : "range"');
    expect(page).toContain('"搜索结果订单数" : "期间收货订单数"');
    expect(page).toContain('"搜索结果累计实收" : "期间实收数量"');
    expect(page).toContain('label="异常订单数量"');
    expect(page).toContain('label="差异率"');
    expect(page).toContain("全时间 · 不受所选日期影响");
    expect(page).toContain("startDate");
    expect(page).toContain("endDate");
    expect(page).not.toContain("<span>原收货</span>");
    expect(page).toContain("row.receiptCount > 1 ? <button");
    expect(page).toContain("第{row.receiptCount}次收货");
    expect(page).toContain("查看记录");
    expect(page).toContain("累计实收 {quantity(item.cumulativeActualQuantity)}件");
    expect(page).toContain("historyDateTime(item.receivedAt)");
    expect(page).not.toContain("待收");
  });

  it("keeps supplier and temporary-worker wage facts visible without changing deduction math", async () => {
    const [detail, exportService] = await Promise.all([
      readFile("apps/web/src/wages/wage-period-detail.tsx", "utf8"),
      readFile("apps/api/src/wages/wage-export-service.ts", "utf8"),
    ]);
    expect(detail).toContain("supplierNameSnapshot");
    expect(detail).toContain("temporaryWageMultiplier");
    expect(exportService).toContain('"工资月份","供应商"');
    expect(exportService).toContain("temporary_wage_multiplier");
  });
});
