import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("external deduction follow-up workflow", () => {
  it("lets business users record supplier feedback and a real next-follow-up deadline", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain('label="供应商反馈（选填）"');
    expect(source).toContain('label="下次跟进时间（选填）"');
    expect(source).toContain('type="datetime-local"');
    expect(source).toContain("supplierFeedback: feedback");
    expect(source).toContain("nextFollowUpAt: new Date(nextValue).toISOString()");
    expect(source).toContain("nextDate.getTime() <= Date.now()");
  });

  it("shows follow-up history instead of making a saved follow-up disappear after refresh", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain("caseItem.followUps.length > 0");
    expect(source).toContain("followUp.content");
    expect(source).toContain("followUp.supplierFeedback");
    expect(source).toContain("followUp.nextFollowUpAt");
    expect(source).toContain('timeZone: "Asia/Shanghai"');
  });
});
