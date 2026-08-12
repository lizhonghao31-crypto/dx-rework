import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework detail permission UX", () => {
  it("does not render cross-node action panels solely from order status", async () => {
    const source = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(source).not.toContain("canUseOrderIndex");
    expect(source).not.toContain('action: "返回全部订单"');
    expect(source).toContain("const canSeeResponsibility = elevated(currentUser)");
    expect(source).toContain("selected.key === \"responsibility\"");
    expect(source).toContain("selected.key === \"responsibility_settlement\"");
    expect(source).toContain("<ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId}");
    expect(source).toContain("<OwnFactoryApprovalPanel key=\"own-factory\"");
    expect(source).toContain("<ExternalResponsibilityPanel key=\"external\"");
    expect(source).not.toContain("const nextAction =");
  });
});
