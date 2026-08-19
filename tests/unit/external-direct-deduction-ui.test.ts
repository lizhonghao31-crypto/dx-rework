import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N09 ledger and merged N10 external deduction UI", () => {
  it("keeps N09 read-only while exposing usable deduction or data-return actions in N10", async () => {
    const [panel, queue] = await Promise.all([
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-queue-page.tsx", "utf8"),
    ]);

    expect(panel).toContain("供应商与扣款倍率已确认，台账只读。");
    expect(panel).toContain("const visibleUnassigned = readOnly || focusCaseId ? [] : unassigned;");
    expect(panel).toContain("!readOnly && caseItem.canRecordDeduction");
    expect(panel).toContain("退回资料问题");
    expect(panel).toContain('variant="primary"');
    expect(panel).toContain("记录实际扣款");
    expect(queue).toContain('pending_payables_confirmation: "待记录扣款"');
    expect(queue).toContain("应付直接记录实际扣款或退回资料问题");
  });
});
