import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow navigation access contract", () => {
  it("keeps responsibility work in its order node instead of exposing N07-N08 as competing menus", async () => {
    const [shell, detail] = await Promise.all([
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
    ]);

    for (const entry of ["我的待办", "订单看板", "发起返工", "返工单看板", "系统管理", "财务报表", "工资管理"]) {
      expect(shell).toContain(`name: "${entry}"`);
    }
    expect(shell).not.toContain('name: "返工上数"');
    expect(shell).not.toContain('name: "N07');
    expect(shell).not.toContain('name: "N08');
    expect(detail).toContain('hasCapability(currentUser, "responsibility:determine")');
    expect(detail).toContain('hasCapability(currentUser, "responsibility:takeover")');
    expect(detail).toContain('hasCapability(currentUser, "responsibility:confirm_high_multiplier")');
    expect(detail).toContain('hasCapability(currentUser, "responsibility:owner_sign")');
    expect(detail).toContain("<ResponsibilityDeterminationPanel");
    expect(detail).toContain("<ExternalResponsibilityPanel");
    expect(detail).not.toContain("<OwnFactoryApprovalPanel");
  });
});
