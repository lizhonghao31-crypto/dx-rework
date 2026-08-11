import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("mobile rework initiation layout", () => {
  it("keeps the actual six submit conditions first and reports their progress", async () => {
    const source = await read("apps/web/src/rework-form.tsx");

    expect(source).toContain("const requiredFieldsComplete = [");
    expect(source).toContain("const requiredCompletionCount = requiredFieldsComplete.filter(Boolean).length;");
    expect(source).toContain("必填项 {requiredCompletionCount}/6");
    expect(source).toContain("先填这 6 项");

    const requiredLabels = [
      "款号（必填）",
      "订单跟单（必填）",
      "加工厂（必填）",
      "问题部位（必填）",
      "返工数量（必填）",
      "问题描述（必填）",
    ];
    const indexes = requiredLabels.map((label) => source.indexOf(label));
    expect(indexes.every((index) => index >= 0)).toBe(true);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
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
    expect(source).toContain("disabled={mutationDisabled || !complete}");
    expect(css).toContain(".rework-initiation-actions");
    expect(css).toContain(".rework-initiation-optional details[open] summary > small");
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
  });
});
