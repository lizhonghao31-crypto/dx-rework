import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("mobile rework initiation layout", () => {
  it("keeps the new N01 as one compact mobile-first page instead of the retired inspection wizard", async () => {
    const [source, css] = await Promise.all([
      read("apps/web/src/rework-v2-form.tsx"),
      read("apps/web/src/rework-v2-form.css"),
    ]);

    expect(source).toContain("款号 <b>*</b>");
    expect(source).toContain("加工厂 <b>*</b>");
    expect(source).toContain("订单跟单 <b>*</b>");
    expect(source).toContain("现场图片 <b>*</b>");
    expect(source).toContain("rework-v2-grid");
    expect(source).not.toContain("InspectionReportStepOne");
    expect(source).not.toContain("InspectionReportStepTwo");
    expect(source).not.toContain("InspectionReportStepThree");
    expect(source).not.toContain("formStep");
    expect(css).toContain("@media(max-width:600px)");
    expect(css).toContain("grid-template-columns:1fr");
    expect(css).toContain("env(safe-area-inset-bottom,0px)");
  });

  it("keeps optional relationships on the same page and preserves the simple save-submit path", async () => {
    const source = await read("apps/web/src/rework-v2-form.tsx");

    for (const label of ["洗水厂", "印绣花厂", "面辅料供应商", "印绣花跟单"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("保存草稿");
    expect(source).toContain("提交返工");
    expect(source).toContain('await confirmInApp("确认提交返工单？")');
    expect(source).toContain('accept="image/jpeg,image/png,image/webp"');
    expect(source).not.toContain("更多订单资料（可补充）");
    expect(source).not.toContain("验货报告步骤");
  });
});
