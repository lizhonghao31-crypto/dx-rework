import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildWageWorkbook } from "../../apps/api/src/wages/wage-export-service.js";

describe("wage web and xlsx delivery", () => {
  it("builds a real deterministic XLSX zip with two worksheets", () => {
    const details = [["未锁定预览"], ["工资月份", "工资金额"], ["2026-07", "1.00"]];
    const summary = [["工人", "工资金额"], ["Worker", "1.00"]];
    const first = buildWageWorkbook(details, summary);
    const second = buildWageWorkbook(details, summary);
    expect(first.subarray(0, 2).toString()).toBe("PK");
    expect(first.equals(second)).toBe(true);
    expect(first.includes(Buffer.from("xl/worksheets/sheet1.xml"))).toBe(true);
    expect(first.includes(Buffer.from("xl/worksheets/sheet2.xml"))).toBe(true);
  });

  it("wires wage viewing, direct month close and exports without review or adjustment", async () => {
    const [app, list, detail, routes, exportService] = await Promise.all([
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-period-list.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-period-detail.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/wages/wage-routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/wages/wage-export-service.ts", import.meta.url), "utf8"),
    ]);
    expect(app).toContain('path === "/ui/wages" || path.startsWith("/ui/wages/")');
    expect(app).toContain('{ requiredCapability: "wage:view" }');
    expect(list).not.toContain("window.setInterval");
    expect(list).not.toContain('window.addEventListener("focus"');
    expect(detail).toContain("wage-periods/${period.periodId}/lock");
    expect(detail).toContain(">月结锁定</Button>");
    expect(detail).toContain("export.xlsx");
    expect(detail).toContain("supplierNameSnapshot");
    expect(detail).toContain("temporaryWageMultiplier");
    expect(detail).toContain("payableAmount");
    expect(detail).not.toContain("工资调整");
    expect(routes).not.toContain("tail-approve");
    expect(routes).not.toContain("administrative-approve");
    expect(routes).not.toContain("administrative-return");
    expect(routes).not.toContain("/wage-adjustments");
    expect(routes).toContain('app.post("/wage-periods/:periodId/lock"');
    expect(exportService).not.toContain("adjustment_amount");
    expect(exportService).not.toContain("rework_wage_adjustments");
    expect(exportService).toContain('"工资月份","供应商"');
    expect(exportService).toContain("line.supplier_name");
  });
});
