import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildWageWorkbook } from "../../apps/api/src/wages/wage-export-service.js";
import { unzipSync } from 'fflate';
import { buildWorkbook, workbookNumberCell } from '../../apps/api/src/reporting/xlsx-workbook.js';

describe("wage web and xlsx delivery", () => {
  it('fits Chinese labels and long values while preserving numeric formats and text safety',()=>{
    const sha='abcdef0123'.repeat(4),long='超长工资来源及返工款号说明'.repeat(8);
    const content=buildWorkbook([{name:'工资明细',fitColumns:true,rows:[['工人姓名快照','返工单号','版本SHA','工资金额','说明'],['张师傅姓名', '00012345678901234567890',sha,workbookNumberCell('12.34000000'),long]]}]);
    const files=unzipSync(content),sheet=Buffer.from(files['xl/worksheets/sheet1.xml']!).toString(),styles=Buffer.from(files['xl/styles.xml']!).toString();
    expect(sheet).toContain('min="1" max="1" width="14"');
    expect(sheet).toContain('min="3" max="3" width="42"');
    expect(sheet).toContain('min="5" max="5" width="72"');
    expect(sheet).toContain('<c r="D2" s="1" t="n"><v>12.34000000</v></c>');
    expect(sheet).toContain('00012345678901234567890');expect(sheet).toContain(long);
    expect(styles).toContain('wrapText="1"');expect(styles).toContain('formatCode="#,##0.##"');
    for(const xml of Object.values(unzipSync(buildWageWorkbook([['工资明细']], [['人员汇总']]))).map(bytes=>Buffer.from(bytes).toString()).filter(xml=>xml.includes('<worksheet ')))expect(xml).toContain('<cols>');
  });
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

  it("wires read-only wage viewing and exports without review, adjustment or month close", async () => {
    const [app, list, detail, routes, exportService] = await Promise.all([
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-period-list.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-period-detail.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/wages/wage-routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/wages/wage-export-service.ts", import.meta.url), "utf8"),
    ]);
    expect(app).toContain('path === "/ui/wages" || path.startsWith("/ui/wages/")');
    expect(app).toContain("requiredAnyOf={financePageRequirements}");
    expect(list).not.toContain("window.setInterval");
    expect(list).not.toContain('window.addEventListener("focus"');
    expect(detail).not.toContain("wage-periods/${period.periodId}/lock");
    expect(detail).not.toContain(">月结锁定</Button>");
    expect(detail).toContain("export.xlsx");
    expect(detail).toContain("supplierNameSnapshot");
    expect(detail).toContain("temporaryWageMultiplier");
    expect(detail).toContain("payableAmount");
    expect(detail).not.toContain("工资调整");
    expect(routes).not.toContain("tail-approve");
    expect(routes).not.toContain("administrative-approve");
    expect(routes).not.toContain("administrative-return");
    expect(routes).not.toContain("/wage-adjustments");
    expect(routes).not.toContain('app.post("/wage-periods/:periodId/lock"');
    expect(exportService).not.toContain("adjustment_amount");
    expect(exportService).not.toContain("rework_wage_adjustments");
    expect(exportService).toContain('"工资月份","供应商"');
    expect(exportService).toContain("line.supplier_name");
  });
});
