import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("N01 paper-report entry", () => {
  it("keeps exactly eight core fields visible and collapses the legacy report into manual entry", async () => {
    const source = await readFile("apps/web/src/rework-form.tsx", "utf8");
    for (const label of ["供应商（必填）", "款号（必填）", "款式（必填）", "颜色（必填）", "验货阶段（必填）", "验货地址（必填）", "订单数量（必填）", "抽检数量（必填）"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("手动录入");
    expect(source).toContain("rework-manual-entry__toggle");
    expect(source).toContain("rework-orders/inspection-report-extractions");
    expect(source).toContain("extractFromReportImage");
  });
});
