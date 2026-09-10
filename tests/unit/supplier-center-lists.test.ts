import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SupplierDirectoryList, SupplierMaintenanceList } from "../../apps/web/src/supplier-center-lists.js";
import type { SupplierSummary } from "../../apps/web/src/supplier-center-model.js";

const supplier: SupplierSummary = {
  supplierId: "fixture-supplier", supplierCode: "FAC_001", supplierName: "合成测试长名称供应商第一生产基地",
  supplierType: "factory", version: 2, active: true, supportedCrafts: ["车缝", "整烫"], dailyCapacity: 12800,
  contractDataMissing: ["bankAccount"], changedAt: "2026-09-10T08:00:00.000Z",
};
const props = { suppliers: [supplier], disabled: false, onSelect: () => {} };

describe("supplier task-specific lists", () => {
  it("offers readonly directory facts and a view action", () => {
    const html = renderToStaticMarkup(createElement(SupplierDirectoryList, props));
    expect(html).toContain("车缝、整烫");
    expect(html).toContain("12,800 件 / 日");
    expect(html).toContain("1 项合同资料缺失");
    expect(html).toContain(`查看 ${supplier.supplierName}`);
    expect(html).not.toContain("维护资料");
    expect(html).not.toContain("最近修改");
  });

  it("shows version time and maintenance action, retaining readonly handling for readers", () => {
    const html = renderToStaticMarkup(createElement(SupplierMaintenanceList, { ...props, canWrite: true }));
    expect(html).toContain("最近修改");
    expect(html).toContain('dateTime="2026-09-10T08:00:00.000Z"');
    expect(html).toContain("维护资料");
    expect(html).not.toContain("12,800 件 / 日");
    const readonly = renderToStaticMarkup(createElement(SupplierMaintenanceList, { ...props, canWrite: false }));
    expect(readonly).not.toContain("维护资料");
    expect(readonly).toContain(`查看 ${supplier.supplierName}`);
  });
});
