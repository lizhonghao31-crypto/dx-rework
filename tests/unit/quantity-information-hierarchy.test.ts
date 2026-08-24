import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N04-N05 quantity information hierarchy", () => {
  it("keeps key work, tail-inspection and reconciliation quantities visually prominent", async () => {
    const [reportingCss, tailCss, reviewCss, review] = await Promise.all([
      read("apps/web/src/work-reporting-form.css"),
      read("apps/web/src/tail-inspection-panel.css"),
      read("apps/web/src/styles.css"),
      read("apps/web/src/whole-order-review-panel.tsx"),
    ]);

    expect(reportingCss).toContain(".work-reporting-page > .dx-surface > .section-title + p");
    expect(tailCss).toContain(".tail-inspection-process small");
    expect(tailCss).toContain(".tail-inspection-entry > .dx-field input");
    expect(reviewCss).toContain(".quantity-process-toggle");
    expect(reviewCss).toContain(".quantity-process-card.is-mismatch");
    expect(reviewCss).toContain(".quantity-report-value");
    expect(review).toContain("<small>工人合计</small>");
    expect(review).toContain("<small>尾查</small>");
    expect(review).toContain("<small>差异</small>");
    expect(review).toContain("主管修改，原值");
  });
});
