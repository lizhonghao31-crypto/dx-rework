import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N04-N05 quantity information hierarchy", () => {
  it("keeps key work, tail-inspection and reconciliation quantities visually prominent", async () => {
    const [reportingCss, tailCss, review] = await Promise.all([
      read("apps/web/src/work-reporting-form.css"),
      read("apps/web/src/tail-inspection-panel.css"),
      read("apps/web/src/whole-order-review-panel.tsx"),
    ]);

    expect(reportingCss).toContain(".work-reporting-page > .dx-surface > .section-title + p");
    expect(reportingCss).toContain(".whole-order-metric-value");
    expect(reportingCss).toContain(".whole-order-gap.is-danger");
    expect(tailCss).toContain(".tail-inspection-process small");
    expect(tailCss).toContain(".tail-inspection-entry > .dx-field input");
    expect(review).toContain('className="whole-order-metric-label">工人原报');
    expect(review).toContain('className="whole-order-metric-label">尾查报数');
    expect(review).toContain("whole-order-gap-value");
    expect(review).toContain("whole-order-report-value");
  });
});

