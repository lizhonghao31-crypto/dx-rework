import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("external deduction finance UI", () => {
  it("keeps finance focused on the actual deduction instead of follow-up administration", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain('label="本次扣款金额"');
    expect(source).toContain("应扣金额");
    expect(source).toContain("累计已扣");
    expect(source).toContain("剩余");
    expect(source).not.toContain('label="供应商反馈（选填）"');
    expect(source).not.toContain('label="下次跟进时间（选填）"');
    expect(source).not.toContain("新增跟进");
  });

  it("keeps deduction evidence upload and immutable deduction history visible", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain("<ExternalEvidenceUploader");
    expect(source).toContain("attachmentIds: files");
    expect(source).toContain("caseItem.deductions.length > 0");
    expect(source).toContain("扣款记录");
    expect(source).toContain("entry.deductedOn");
    expect(source).toContain("entry.amount");
  });
});
