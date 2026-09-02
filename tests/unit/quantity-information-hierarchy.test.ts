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
    expect(reportingCss).toContain(".n04-process-list {\n    gap: 4px");
    expect(reportingCss).toContain("grid-template-columns: minmax(76px, 1.4fr) repeat(3, minmax(36px, .65fr)) auto");
    expect(reportingCss).toContain(".n04-process-group__main > strong {\n    overflow: visible");
    expect(reportingCss).toContain("min-height: 28px");
    expect(tailCss).toContain(".tail-inspection-process small");
    expect(tailCss).toContain(".tail-inspection-entry > .dx-field input");
    expect(reviewCss).toContain(".quantity-process-toggle");
    expect(reviewCss).toContain(".quantity-process-card.is-mismatch");
    expect(reviewCss).toContain(".quantity-report-value");
    expect(reviewCss).toContain(".quantity-process-price");
    expect(reviewCss).toContain(".quantity-process-price__review");
    expect(reviewCss).toContain("grid-template-columns: repeat(4, minmax(0, 1fr)) 20px");
    expect(reviewCss).toContain(".quantity-process-name { grid-column: 1 / -2");
    expect(reviewCss).toContain("white-space: normal");
    expect(reviewCss).toContain(".quantity-process-list { gap: 4px");
    expect(reviewCss).toContain("min-height: 30px");
    const processToolbar = review.slice(
      review.indexOf("const canSaveProcess"),
      review.indexOf('{open && <div className="quantity-process-detail">'),
    );
    expect(reviewCss).toContain(".quantity-process-toolbar > .quantity-process-save");
    expect(reviewCss).toContain("background: var(--dx-v2-color-inset)");
    expect(reviewCss).toContain("box-shadow: 0 8px 24px");
    expect(reviewCss).toContain("box-shadow: none");
    expect(review).toContain('className="quantity-process-toolbar"');
    expect(review).toContain("disabled={busy || !processHasChanges}");
    expect(processToolbar).toContain('className="quantity-process-save"');
    expect(processToolbar).not.toContain("quantity-report-actions quantity-process-save");
    expect(review).toContain("<small>工人合计</small>");
    expect(review).toContain("<small>整查</small>");
    expect(review).toContain("<small>整查余量</small>");
    expect(review).toContain("主管修改，原值");
    expect(review).toContain('process.pricingUnit === "piece" ? "件" : "小时"');
    expect(review).toContain("formatBusinessDecimal(value, 3)");
    expect(review).toContain('tone={ready ? "success" : "warning"}');
    expect(review).toContain('填写每个工序有效的最终单价');
    expect(review).toContain("processPrices: prices.map");
    expect(review).not.toContain("价格有调整");
    expect(reviewCss).toContain(".quantity-price-decision__button.is-approve");
    expect(reviewCss).toContain("color: var(--color-success, #176b45)");
    expect(reviewCss).toContain(".quantity-price-decision__button.is-reject");
    expect(reviewCss).toContain("color: var(--color-danger, #a12b2b)");
    expect(review).toContain("原价格不变并保留本版审计记录");
  });
});
