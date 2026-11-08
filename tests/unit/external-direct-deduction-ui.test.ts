import {ExternalResponsibilityQueueStatusLabels} from "@dx-rework/contracts/external-responsibility";
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N10 external deduction UI", () => {
  it("keeps the settlement view readable and gives finance only the core deduction actions", async () => {
    const [panel, queue] = await Promise.all([
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
      readFile("apps/web/src/external-responsibility-queue-page.tsx", "utf8"),
    ]);

    expect(panel).toContain('readOnly ? "责任结算台账" : "供应商扣款"');
    expect(panel).toContain("应扣金额");
    expect(panel).toContain("累计已扣");
    expect(panel).toContain("本次扣款金额");
    expect(panel).toContain('onClick={() => void recordDeduction(caseItem)}');
    expect(panel).toContain('onClick={() => void requestRevision(caseItem)}');
    expect(panel).toContain("重判责任");
    expect(panel).toContain("<ExternalEvidenceUploader");
    expect(panel).not.toContain("新增跟进");
    expect(panel).not.toContain("按部分关闭");
    expect(panel).not.toContain("登记未扣成功");
    expect(panel).not.toContain('label="扣款凭证号（选填）"');
    expect(ExternalResponsibilityQueueStatusLabels.pending_payables_confirmation).toBe("待扣款");
    expect(queue).toContain("ExternalResponsibilityQueueStatusLabels as statusLabel");
    expect(queue).toContain("statusLabel[item.status]");
    expect(queue).toContain("录入本次实际扣款并按现有流程完成");
  });

  it("auto-closes a fully deducted ledger while leaving a recovery action if close fails", async () => {
    const panel = await readFile("apps/web/src/external-responsibility-panel.tsx", "utf8");
    expect(panel).toContain('recorded.remainingAmount === "0.00" && recorded.canClose');
    expect(panel).toContain("await closeFull(recorded)");
    expect(panel).toContain("完成扣款");
    expect(panel).toContain("confirmDeductionException");
  });
});
