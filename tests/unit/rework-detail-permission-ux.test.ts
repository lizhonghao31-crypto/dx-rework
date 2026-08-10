import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework detail permission UX", () => {
  it("does not render cross-node action panels solely from order status", async () => {
    const source = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(source).toContain("canUseTaskList(currentUser)");
    expect(source).toContain("const canSeeResponsibility = elevated(currentUser)");
    expect(source).toContain("canSeeResponsibility ? <ResponsibilityDeterminationPanel");
    expect(source).toContain("canSeeOwnFactory ? <OwnFactoryApprovalPanel");
    expect(source).toContain("canSeeExternal ? <ExternalResponsibilityPanel");
    expect(source).toContain("showResponsibility && (canSeeResponsibility || canSeeOwnFactory || canSeeExternal)");
    expect(source).not.toContain("const nextAction =");
  });
});
