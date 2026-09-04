import { readFile } from "node:fs/promises";

import {
  businessValue,
  formatBusinessDecimal,
  isBusinessMoneyField,
  isBusinessNumberField,
} from "@dx-rework/contracts/business-display";
import { describe, expect, it } from "vitest";

import {
  buildWorkbook,
  workbookNumberCell,
} from "../../apps/api/src/reporting/xlsx-workbook.js";

describe("system business number presentation", () => {
  it("groups ordinary business quantities and amounts without changing identifiers", () => {
    expect(formatBusinessDecimal(12345)).toBe("12,345");
    expect(formatBusinessDecimal(-1849)).toBe("-1,849");
    expect(formatBusinessDecimal("15052.50")).toBe("15,052.5");
    expect(businessValue("plannedQuantity", 12345)).toBe("12,345");
    expect(businessValue("exceptionCount", 12345)).toBe("12,345");
    expect(businessValue("totalAmount", "12345.60")).toBe("¥12,345.6");
    expect(businessValue("orderNo", "12345")).toBe("12345");
    expect(businessValue("version", 12345)).toBe("12345");
    expect(isBusinessNumberField("actualQuantity")).toBe(true);
    expect(isBusinessMoneyField("wageAmount")).toBe(true);
  });

  it("keeps Excel values numeric and applies grouped number formats", () => {
    const workbook = buildWorkbook([{
      name: "数字",
      rows: [
        ["业务数量", "高精度原值", "订单号"],
        [workbookNumberCell(12345), workbookNumberCell("12345.6789", "precise"), "0012345"],
      ],
    }]);
    expect(workbook.includes(Buffer.from('formatCode="#,##0.##"'))).toBe(true);
    expect(workbook.includes(Buffer.from('formatCode="#,##0.########"'))).toBe(true);
    expect(workbook.includes(Buffer.from('s="1" t="n"><v>12345</v>'))).toBe(true);
    expect(workbook.includes(Buffer.from('s="2" t="n"><v>12345.6789</v>'))).toBe(true);
    expect(workbook.includes(Buffer.from("<t xml:space=\"preserve\">0012345</t>"))).toBe(true);
  });

  it("uses the shared formatter across key business quantity surfaces", async () => {
    const paths = [
      "apps/web/src/order-board-page.tsx",
      "apps/web/src/receiving-page.tsx",
      "apps/web/src/rework-detail-page.tsx",
      "apps/web/src/work-reporting-form.tsx",
      "apps/web/src/whole-order-review-panel.tsx",
      "apps/web/src/tail-inspection-panel.tsx",
      "apps/web/src/reporting/management-dashboard-page.tsx",
      "apps/web/src/reporting/workflow-queue-page.tsx",
      "apps/web/src/wages/wage-period-list.tsx",
      "apps/web/src/sourcing-workspace-page.tsx",
    ];
    const sources = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    for (const source of sources) expect(source).toContain("formatBusinessDecimal");
    expect(sources.at(-1)).not.toContain('quantity.toLocaleString("zh-CN")');
  });
});
