import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("mobile rework initiation layout", () => {
  it("splits the digital inspection report into three navigable steps", async () => {
    const [source, reportSource] = await Promise.all([
      read("apps/web/src/rework-form.tsx"),
      read("apps/web/src/inspection-report-form.tsx"),
    ]);

    expect(source).toContain("const requiredFieldsComplete = [");
    expect(source).toContain("const requiredCompletionCount = requiredFieldsComplete.filter(Boolean).length;");
    expect(source).toContain("第 {formStep}/3 步");
    expect(source).toContain("InspectionReportStepOne");
    expect(source).toContain("InspectionReportStepTwo");
    expect(source).toContain("InspectionReportStepThree");
    expect(source).toContain('aria-label="验货报告步骤"');
    expect(source).not.toMatch(/\n}\n\n}$/);

    expect(reportSource).toContain("验货基本资料");
    expect(reportSource).toContain("尺寸核验");
    expect(reportSource).toContain("资料核对");
    expect(reportSource).toContain("面辅料查验");
    expect(reportSource).toContain("验货问题总结");
    expect(reportSource).toContain("结论与签名");
  });

  it("keeps non-blocking order data collapsible and preserves the existing action path", async () => {
    const [source, css] = await Promise.all([
      read("apps/web/src/rework-form.tsx"),
      read("apps/web/src/styles.css"),
    ]);

    expect(source).toContain("更多订单资料（可补充）");
    expect(source).toContain("<details>");
    expect(source).toContain("QC 证据");
    expect(source).toContain('className="mobile-actions rework-initiation-actions"');
    expect(source).toContain("formStep === 3 && !complete");
    expect(source).toContain("{formStep < 3 ? \"下一步\" : \"提交返工\"}");
    expect(css).toContain(".rework-initiation-actions");
    expect(css).toContain(".inspection-measurement-row");
    expect(css).toContain(".inspection-step-navigation");
    expect(css).toContain(".rework-initiation-optional details[open] summary > small");
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
  });
});
