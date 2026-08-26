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
    expect(source).toContain("上传报告 <b>*</b>");
    expect(source).toContain("rework-v2-grid");
    expect(source).not.toContain("InspectionReportStepOne");
    expect(source).not.toContain("InspectionReportStepTwo");
    expect(source).not.toContain("InspectionReportStepThree");
    expect(source).not.toContain("formStep");
    expect(css).toContain("@media(max-width:600px)");
    expect(css).toContain("grid-template-columns:1fr");
    expect(css).toContain("env(safe-area-inset-bottom,0px)");
    expect(css).toContain(".rework-v2-upload");
    expect(css).toContain("background:#fff");
  });

  it("folds optional relationships under more info and makes draft save navigation-proof", async () => {
    const source = await read("apps/web/src/rework-v2-form.tsx");

    expect(source).toContain('<details className="rework-v2-more">');
    expect(source).toContain("<summary>更多信息</summary>");
    for (const label of ["洗水厂", "印绣花厂", "面辅料供应商", "印绣花跟单"]) {
      expect(source).toContain(label);
    }
    expect(source).toContain("保存草稿");
    expect(source).toContain("提交返工");
    expect(source).toContain('await confirmInApp("确认提交返工单？")');
    expect(source).toContain('accept="image/*"');
    const saveBlock = source.match(/const save = async \(\): Promise<void> => \{[\s\S]*?\n {2}const submit = async/);
    expect(saveBlock?.[0]).toBeTruthy();
    expect(saveBlock?.[0]).not.toContain("onOrderChanged");
    expect(saveBlock?.[0]).not.toContain("window.location");
    expect(source).toContain('type="button"');
    expect(source).toContain("event.preventDefault();");
    expect(source).toContain("event.stopPropagation();");
    expect(source).not.toContain("更多订单资料（可补充）");
    expect(source).not.toContain("验货报告步骤");
  });

  it("places N01 feedback with the submit actions instead of a standalone surface", async () => {
    const [source, css] = await Promise.all([
      read("apps/web/src/rework-v2-form.tsx"),
      read("apps/web/src/rework-v2-form.css"),
    ]);
    expect(source).not.toContain('className="rework-v2-status"');
    expect(source).toContain('className="rework-v2-action-area"');
    expect(source).toContain('className="rework-v2-action-feedback" role="status"');
    expect(source.indexOf('className="rework-v2-actions"')).toBeLessThan(
      source.indexOf('className="rework-v2-action-feedback"'),
    );
    expect(css).toContain(".rework-v2-action-feedback");
    expect(css).not.toContain(".rework-v2-status");
  });
});
