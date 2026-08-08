import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("business-facing workflow UI", () => {
  it("does not send N08-only users back into an N07 page they may not be allowed to open", async () => {
    const source = await read("apps/web/src/own-factory-approval-queue-page.tsx");
    expect(source).not.toContain('action="返回责任处理"');
    expect(source).not.toContain('actionHref="/ui/responsibility"');
  });

  it("does not expose internal rework UUIDs as queue or management-card labels", async () => {
    const sources = await Promise.all([
      read("apps/web/src/responsibility-queue-page.tsx"),
      read("apps/web/src/own-factory-approval-queue-page.tsx"),
      read("apps/web/src/external-responsibility-queue-page.tsx"),
      read("apps/web/src/reporting/management-order-card.tsx"),
    ]);
    for (const source of sources) {
      expect(source).not.toContain("reworkNo ?? item.reworkOrderId");
      expect(source).not.toContain("reworkNo ?? order.reworkOrderId");
    }
  });

  it("keeps wage detail labels in business Chinese instead of raw enum values", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");
    expect(source).toContain('item.pricingUnitSnapshot === "piece" ? "件" : "小时"');
    expect(source).toContain("adjustmentStatusLabel(adjustment.status)");
    expect(source).toContain("reviewStageLabel(action.stage)");
    expect(source).toContain("reviewDecisionLabel(action.decision)");
    expect(source).toContain("formatBusinessTime(action.actedAt)");
  });

  it("shows N08 approval proportions as percentages and times in the business timezone", async () => {
    const source = await read("apps/web/src/own-factory-approval-panel.tsx");
    expect(source).toContain("bpsToPercent(process.ownFactoryShareBps)");
    expect(source).toContain("bpsToPercent(line.shareBps)");
    expect(source).not.toContain("ownFactoryShareBps} bps");
    expect(source).not.toContain("shareBps} bps");
    expect(source).not.toContain("qualityControl.initiatedBy}");
    expect(source).not.toContain("wholeOrderReview.reviewedBy}");
    expect(source).toContain('timeZone: "Asia/Shanghai"');
    expect(source).toContain("formatBusinessTime(approval.decision.decidedAt)");
  });

  it("lets N07 users work in percentages while preserving bps at the API boundary", async () => {
    const source = await read("apps/web/src/responsibility-determination-panel.tsx");
    expect(source).toContain('label="比例（%）"');
    expect(source).toContain("parsePercentToBps(allocation.sharePercent)");
    expect(source).toContain("shareBps: Number(allocation.shareBps)");
    expect(source).toContain('" · 必须严格等于 100%"');
    expect(source).not.toContain('label="比例（bps）"');
    expect(source).not.toContain("返工单：{response?.reworkOrderId");
  });
});
