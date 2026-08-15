import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("N01 streamlined manual entry", () => {
  it("keeps exactly eight core fields visible without image recognition", async () => {
    const source = await readFile("apps/web/src/rework-form.tsx", "utf8");
    for (const label of ["供应商（必填）", "款号（必填）", "款式（必填）", "颜色（必填）", "验货阶段（必填）", "验货地址（必填）", "订单数量（必填）", "抽检数量（必填）"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("手动录入");
    expect(source).toContain("rework-manual-entry__toggle");
    expect(source).not.toContain("rework-orders/inspection-report-extractions");
    expect(source).not.toContain("extractFromReportImage");
    expect(source).toContain('inspectionLocation: "仓库"');
    expect(source).toContain("<HistorySearchInput");
  });

  it("shows unified attachments and paginates manual report modules", async () => {
    const source = await readFile("apps/web/src/rework-form.tsx", "utf8");
    expect(source).toContain("订单附件");
    expect(source).toContain("验货报告、衣服照片及其他现场图片统一上传");
    expect(source).toContain("manualEntryPage === 1");
    expect(source).toContain("manualEntryPage === 5");
    expect(source).toContain('aria-label="手动录入分页"');
  });
});
