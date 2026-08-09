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

  it("lets one rework reference multiple order numbers without changing the one-style boundary", async () => {
    const source = await read("apps/web/src/rework-form.tsx");
    expect(source).toContain("一张返工单一个款号");
    expect(source).toContain('label="订单号（可填多个，知道时填写）"');
    expect(source).toContain('maxLength={100}');
    expect(source).toContain('placeholder="多个订单号用逗号分隔，例如：PO001，PO002"');
  });

  it("makes worker completion entry explicit and closes reporting after completion", async () => {
    const source = await read("apps/web/src/work-reporting-form.tsx");
    expect(source).toContain("actualQuantity > task.remainingQuantity");
    expect(source).toContain('max={String(task.remainingQuantity)}');
    expect(source).toContain('label={`本次完成数量（${unit}）`}');
    expect(source).toContain('label="实际完成时间"');
    expect(source).toContain("全部完成剩余 {task.remainingQuantity}");
    expect(source).toContain("task.remainingQuantity <= 0");
    expect(source).toContain('["pending_task_assignment", "in_progress"].includes(data.reworkStatus)');
    expect(source).toContain("订单已自动流转到 N06 · 待整单审核");
    expect(source).toContain("canReviewOrder(me.user)");
    expect(source).not.toContain('label="本次上数（${unit}）"');
    expect(source).not.toContain('label="完工时间"');
    expect(source).not.toContain('data?.reworkOrderId ?? reworkOrderId ?? "返工任务"');
    expect(source).not.toContain("share.toFixed(8)");
    expect(source).not.toContain("result.groupAmount.toFixed(8)");
  });

  it("separates normal whole-order confirmation from quantity exceptions", async () => {
    const [source, css] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/web/src/work-reporting-form.css"),
    ]);
    expect(source).toContain("工序完成状态（系统自动计算）");
    expect(source).toContain("确认本单返工全部完成，进入责任判定");
    expect(source).toContain("异常处理：数量调整");
    expect(source).toContain("<details");
    expect(source).toContain('kind === "decrease" && target >= process.plannedQuantity');
    expect(source).toContain('kind === "decrease" && target < process.completedQuantity');
    expect(source).toContain('kind === "increase" && target <= process.plannedQuantity');
    expect(source).toContain("oneDecimalQuantity.test(rawTarget)");
    expect(source).toContain('className="mobile-actions whole-order-actions"');
    expect(css).toContain(".work-reporting-page .whole-order-actions");
    expect(css).toContain("position: static;");
    expect(css).toContain("grid-template-columns: 1fr;");
  });

  it("uses real dynamic node workbenches instead of empty pages requiring a rework id", async () => {
    const [app, queue, dashboard, detail, navigation] = await Promise.all([
      read("apps/web/src/App.tsx"),
      read("apps/web/src/reporting/workflow-queue-page.tsx"),
      read("apps/web/src/reporting/management-dashboard-page.tsx"),
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/components.tsx"),
    ]);
    expect(app).toContain("<WorkflowQueuePage active=\"工序配置\"");
    expect(app).toContain("<WorkflowQueuePage active=\"返工执行\"");
    expect(navigation).toContain('name: "返工执行"');
    expect(navigation).toContain('description: "分配人员、登记完成数量、整单确认"');
    expect(navigation).not.toContain('name: "分工上数"');
    expect(queue).toContain("搜索当前节点订单");
    expect(queue).toContain("谁来处理");
    expect(queue).toContain("当前要做什么");
    expect(queue).toContain("完成后去哪里");
    expect(queue).toContain("订单只有进入这个真实节点后才会出现在这里");
    expect(dashboard).toContain("进入节点工作台 →");
    expect(detail).toContain("统一查询只保留单据事实和全链路信息，不再承担日常节点操作入口");
    expect(detail).not.toContain("const nextAction =");
  });

  it("stops cancelled orders from aging without hiding post-completion external follow-up", async () => {
    const [card, query] = await Promise.all([
      read("apps/web/src/reporting/management-order-card.tsx"),
      read("apps/api/src/reporting/management-reporting-orders.ts"),
    ]);
    expect(card).toContain("已取消 · 停止计时");
    expect(card).toContain("已退出在途、逾期和当前异常统计");
    expect(card).toContain("独立的外部扣款后续仍按实际状态统计");
    expect(query).toContain("order_record.status IN ('completed','cancelled') THEN 0");
    expect(query).toContain("order_record.status='cancelled' THEN false");
    expect(query).toContain("order_record.status='cancelled' THEN 0");
    expect(query).toContain("searched_person.display_name ILIKE");
  });

  it("adds search to every responsibility-stage workbench", async () => {
    const sources = await Promise.all([
      read("apps/web/src/responsibility-queue-page.tsx"),
      read("apps/web/src/own-factory-approval-queue-page.tsx"),
      read("apps/web/src/external-responsibility-queue-page.tsx"),
    ]);
    for (const source of sources) expect(source).toContain("搜索当前节点");
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
