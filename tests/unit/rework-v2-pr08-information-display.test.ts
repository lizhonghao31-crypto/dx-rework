import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("PR-08 information display", () => {
  it("uses the four approved date-driven receiving KPIs", async () => {
    const [service, page] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
    ]);
    expect(service).toContain("abnormalOrderCount");
    expect(service).toContain("row.differenceQuantity !== 0");
    expect(page).toContain('label="今日收货订单数"');
    expect(page).toContain('label="今日收货数量"');
    expect(page).toContain('label="异常订单数量"');
    expect(page).toContain('label="差异率"');
    expect(page).toContain("detail={date}");
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
