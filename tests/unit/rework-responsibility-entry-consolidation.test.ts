import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { hasLowerExternalRevisionAction } from "../../apps/web/src/order-responsibility-revision-panel.js";

describe("rework responsibility entry consolidation", () => {
  it("prefers the existing lower external revision action when that action is available", () => {
    expect(hasLowerExternalRevisionAction(null)).toBe(false);
    expect(hasLowerExternalRevisionAction({ cases: [] })).toBe(false);
    expect(hasLowerExternalRevisionAction({ cases: [{ canRequestRevision: false }] })).toBe(false);
    expect(hasLowerExternalRevisionAction({ cases: [{ canRequestRevision: true }] })).toBe(true);
  });

  it("keeps the order-level panel compact and visually after the handling workspace", async () => {
    const [panel, polish] = await Promise.all([
      readFile("apps/web/src/order-responsibility-revision-panel.tsx", "utf8"),
      readFile("apps/web/src/ui-polish.css", "utf8"),
    ]);
    expect(panel).not.toContain("责任结果");
    expect(panel).toContain("责任历史");
    expect(panel).toContain("lowerRevisionAvailable === false");
    expect(polish).toContain(".rework-detail-target-layout > .rework-responsibility-result--compact");
    expect(polish).toContain("order: 100");
  });
});
