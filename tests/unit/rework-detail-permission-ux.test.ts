import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework detail permission UX", () => {
  it("does not render cross-node action panels solely from order status", async () => {
    const source = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(source).not.toContain("canUseOrderIndex");
    expect(source).not.toContain('action: "返回全部订单"');
    expect(source).toContain("const canSeeResponsibility = elevated(currentUser)");
    expect(source).toContain("selected.key === \"responsibility\"");
    expect(source).toContain("selected.key === \"owner_signature\"");
    expect(source).toContain("selected.key === \"settlement_ledger\"");
    expect(source).toContain("selected.key === \"settlement_followup\"");
    expect(source).toContain("{canSeeExternal ? <ExternalResponsibilityPanel");
    expect(source).toContain("<ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId}");
    expect(source).not.toContain("WageSettlementFollowUp");
    expect(source).not.toContain("wageStatusLabel");
    expect(source).toContain("订单完成即进入扣款");
    expect(source).toContain("<ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId}");
    expect(source).toContain("<ExternalResponsibilityPanel reworkOrderId={detail.reworkOrderId} readOnly");
    expect(source).not.toContain("<OwnFactoryApprovalPanel");
    expect(source).toContain('selected.state !== "future"');
    expect(source).toContain('if (selected.state === "current") return <NodePermissionNotice');
    expect(source).toContain('selected.state === "current" || selected.state === "followup"');
    expect(source).toContain("return renderNodePreview()");
    expect(source).not.toContain("const nextAction =");
  });
});
