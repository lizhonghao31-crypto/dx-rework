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

  it("keeps the external deduction workspace in business language and only shows usable fields", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain("responsibilityTypeLabel[caseItem.responsibilityType]");
    expect(source).toContain("bpsToPercent(item.shareBpsSnapshot)");
    expect(source).toContain("deductionEntryLabel[entry.entryType]");
    expect(source).toContain("closureResultLabel[caseItem.closure.result]");
    expect(source).toContain("caseItem.canRecordDeduction && <>");
    expect(source).toContain("hasEditableFields && <div className=\"external-operation\"");
    expect(source).not.toContain("item.configurationItemId)} · {item.responsibilityType}");
    expect(source).not.toContain("{caseItem.responsibilityType}");
    expect(source).not.toContain("{item.shareBpsSnapshot} bps");
    expect(source).not.toContain("· 版本 {caseItem.caseVersion}");
    expect(source).not.toContain("已生成 N07 草稿 {item.seededDeterminationId}");
  });

  it("records the real external deduction date and optional business reference", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain('label="实际扣款日期"');
    expect(source).toContain('type="date"');
    expect(source).toContain("max={shanghaiBusinessDate()}");
    expect(source).toContain('label="扣款凭证号（选填）"');
    expect(source).toContain("deductedOn: deductedOn[caseItem.caseId] ?? shanghaiBusinessDate()");
    expect(source).toContain("...(referenceNo ? { referenceNo } : {})");
    expect(source).toContain('deductionDate > shanghaiBusinessDate()');
  });

  it("keeps worker reporting mobile-friendly without exposing the internal order id", async () => {
    const source = await read("apps/web/src/work-reporting-form.tsx");
    expect(source).toContain("actualQuantity > task.remainingQuantity");
    expect(source).toContain('max={String(task.remainingQuantity)}');
    expect(source).toContain('type="number"');
    expect(source).toContain("formatMoney(result.groupAmount)");
    expect(source).toContain("成员版本 V{task.version}");
    expect(source).toContain("当前返工任务");
    expect(source).not.toContain('data?.reworkOrderId ?? reworkOrderId ?? "返工任务"');
    expect(source).not.toContain("share.toFixed(8)");
    expect(source).not.toContain("result.groupAmount.toFixed(8)");
  });

  it("validates N06 quantity direction before submit and keeps card actions non-sticky", async () => {
    const [source, css] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/web/src/work-reporting-form.css"),
    ]);
    expect(source).toContain('kind === "decrease" && target >= process.plannedQuantity');
    expect(source).toContain('kind === "decrease" && target < process.completedQuantity');
    expect(source).toContain('kind === "increase" && target <= process.plannedQuantity');
    expect(source).toContain('process.pricingUnit === "piece" && !Number.isInteger(target)');
    expect(source).toContain('className="mobile-actions whole-order-actions"');
    expect(css).toContain(".work-reporting-page .whole-order-actions");
    expect(css).toContain("position: static;");
    expect(css).toContain("grid-template-columns: 1fr;");
  });

  it("uses business state labels for queue cards instead of generic deadline wording", async () => {
    const [components, responsibility, ownFactory, external] = await Promise.all([
      read("apps/web/src/components.tsx"),
      read("apps/web/src/responsibility-queue-page.tsx"),
      read("apps/web/src/own-factory-approval-queue-page.tsx"),
      read("apps/web/src/external-responsibility-queue-page.tsx"),
    ]);
    expect(components).toContain("task.stateLabel ?? (");
    expect(responsibility).toContain("stateLabel,");
    expect(ownFactory).toContain('stateLabel: item.canDecide ? "待审批" : "仅查看"');
    expect(external).toContain('stateLabel: item.overdue ? "已逾期" : item.canAct ? "待处理" : "仅查看"');
  });
});
