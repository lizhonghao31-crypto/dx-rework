import { readdir, readFile } from "node:fs/promises";
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

  it("keeps wage detail labels in business Chinese after review and adjustment retirement", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");
    expect(source).toContain('item.pricingUnitSnapshot === "piece" ? "件" : "小时"');
    expect(source).toContain('const statusLabel = period.status === "locked" ? "已月结" : "可月结";');
    expect(source).toContain("<h2>月结状态</h2>");
    expect(source).toContain("工资已经汇总，可在自然月结束后直接月结锁定。");
    expect(source).not.toContain("adjustmentStatusLabel");
    expect(source).not.toContain("工资调整");
    expect(source).not.toContain("reviewStageLabel");
    expect(source).not.toContain("reviewDecisionLabel");
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

  it("lets N08 users select exactly one party and set the external deduction multiplier", async () => {
    const source = await read("apps/web/src/responsibility-determination-panel.tsx");
    expect(source).toContain("主责任方");
    expect(source).toContain("parsePercentToBps(allocation.sharePercent)");
    expect(source).toContain("shareBps: Number(allocation.shareBps)");
    expect(source).toContain("外部扣款倍率（最低 1.2）");
    expect(source).toContain("责任供应商");
    expect(source).not.toContain('label="承担比例（%）"');
    expect(source).not.toContain('label="承担比例（bps）"');
    expect(source).not.toContain("返工单：{response?.reworkOrderId");
  });

  it("keeps the external deduction workspace focused on amounts, evidence and rejudgment", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain("responsibilityTypeLabel[caseItem.responsibilityType]");
    expect(source).toContain("deductionEntryLabel[entry.entryType]");
    expect(source).toContain("const canRecordDeduction = !readOnly && caseItem.canRecordDeduction");
    expect(source).toContain("external-finance-summary");
    expect(source).toContain("本次扣款金额");
    expect(source).toContain("<ExternalEvidenceUploader");
    expect(source).toContain("重判责任");
    expect(source).not.toContain("供应商反馈（选填）");
    expect(source).not.toContain("未扣差额最终处理");
    expect(source).not.toContain("· 版本 {caseItem.caseVersion}");
    expect(source).not.toContain("已生成 N07 草稿 {item.seededDeterminationId}");
  });

  it("records the Shanghai business date automatically without extra finance inputs", async () => {
    const source = await read("apps/web/src/external-responsibility-panel.tsx");
    expect(source).toContain("deductedOn: shanghaiBusinessDate()");
    expect(source).not.toContain('label="实际扣款日期"');
    expect(source).not.toContain('label="扣款凭证号（选填）"');
    expect(source).not.toContain("deductionReference");
    expect(source).not.toContain("deductedOn[");
  });

  it("keeps one style per rework while leaving order numbers to the upstream order domain", async () => {
    const source = await read("apps/web/src/rework-v2-form.tsx");
    expect(source).toContain("款号 <b>*</b>");
    expect(source).toContain("styleNo: form.styleNo.trim() || null");
    expect(source).not.toContain("订单号（可填多个，知道时填写）");
    expect(source).not.toContain("多个订单号用逗号分隔");
    expect(source).not.toContain("orderNo:");
  });

  it("keeps worker completion to one final-count action and closes reporting after everyone completes", async () => {
    const source = await read("apps/web/src/work-reporting-form.tsx");
    expect(source).toContain("我已完工&上数");
    expect(source).toContain("请输入您的实际完工件数");
    expect(source).toContain("返回返工");
    expect(source).toContain("临时工代上数");
    expect(source).toContain('const workReportingWritable = data?.reworkStatus === "in_progress";');
    expect(source).toContain("已流转至 N06 · 尾部主管整单确认");
    expect(source).toContain("canReviewOrder(me.user)");
    expect(source).not.toContain("登记本次完成数量");
    expect(source).not.toContain('label="实际完成时间"');
    expect(source).not.toContain('data?.reworkOrderId ?? reworkOrderId ?? "返工任务"');
    expect(source).not.toContain("share.toFixed(8)");
    expect(source).not.toContain("result.groupAmount.toFixed(8)");
  });

  it("keeps execution workspaces on isolated pages with server-backed state boundaries", async () => {
    const [detail, reporting, reportingService, reviewService, processConfiguration, mergedProcess] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/work-reporting-form.tsx"),
      read("apps/api/src/rework/work-reporting-service.ts"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
      read("apps/web/src/process-configuration-form.tsx"),
      read("apps/web/src/process-worker-assignment-form.tsx"),
    ]);

    expect(detail).toContain("taskMode={selected.key}");
    expect(detail).toContain("onOrderChanged={syncAfterNodeAction}");
    expect(detail).toContain('url.searchParams.set("node", nextNode)');
    expect(detail).toMatch(/<ProcessConfigurationForm[\s\S]*?reworkOrderId=\{detail\.reworkOrderId\}[\s\S]*?onOrderChanged=\{syncAfterNodeAction\}[\s\S]*?\/>/);
    expect(processConfiguration).toContain("onOrderChanged?: () => Promise<void> | void;");
    expect(processConfiguration).toContain("ProcessWorkerAssignmentForm");
    expect((mergedProcess.match(/await onOrderChanged\?\.\(\);/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(reporting).toContain('effectiveTaskMode === "task_assignment"');
    expect(reporting).toContain('effectiveTaskMode === "work_reporting"');
    expect(reporting).toContain('effectiveTaskMode === "whole_order_review"');
    expect(reporting).not.toContain("N04–N06");
    expect(reporting).not.toContain("当前处理说明");
    expect(reporting).not.toContain("全部完成剩余");
    expect(mergedProcess).not.toContain("当前处理说明");
    expect(reportingService).toContain('order.status !== "in_progress"');
    expect(reportingService).toContain('order.status !== "pending_task_assignment"');
    expect(reportingService).toContain("rework.work_task.assignment_confirm");
    expect(reviewService).toContain('order.status !== "pending_order_review"');
  });

  it("removes the duplicated current-processing explanation card from every web node", async () => {
    const paths = (await readdir("apps/web/src", { recursive: true }))
      .filter((path) => typeof path === "string" && /\.(?:ts|tsx)$/.test(path));
    const source = (await Promise.all(paths.map((path) => read(`apps/web/src/${path}`)))).join("\n");
    expect(source).not.toContain("当前处理说明");
  });

  it("uses the tail-count reconciliation instead of the retired quantity-exception path", async () => {
    const [source, css] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/web/src/work-reporting-form.css"),
    ]);
    expect(source).toContain("工人上数与尾查汇总对照");
    expect(source).toContain("确认整单并进入责任判定");
    expect(source).toContain("工人有效上数不得超过尾查件数");
    expect(source).toContain("countGap");
    expect(source).not.toContain("quantity-adjustments");
    expect(source).not.toContain("oneDecimalQuantity");
    expect(source).toContain('className="mobile-actions whole-order-actions"');
    expect(css).toContain(".work-reporting-page .whole-order-actions");
    expect(css).toContain("position: static;");
    expect(css).toContain("grid-template-columns: 1fr;");
  });

  it("uses real order-node workbenches instead of competing standalone workflow menus", async () => {
    const [detail, navigation] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/components.tsx"),
    ]);
    for (const entry of ["我的待办", "订单看板", "发起返工", "返工单看板", "系统管理", "财务报表"]) {
      expect(navigation).toContain(`name: "${entry}"`);
    }
    expect(navigation).not.toContain('name: "返工执行"');
    expect(navigation).not.toContain('name: "返工上数"');
    expect(detail).toContain("rework-detail-target-layout");
    expect(detail).toContain("rework-detail-overview-grid");
    expect(detail).toContain("rework-workflow__mobile-rail");
    expect(detail).toContain("rework-workflow__stage");
    expect(detail).toContain("<ProcessConfigurationForm");
    expect(detail).toContain("<WorkReportingForm");
    expect(detail).toContain("<ResponsibilityDeterminationPanel");
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
    expect(responsibility).toContain("const stateLabel = item.canConfirmHighMultiplier");
    expect(responsibility).toContain("tone, stateLabel");
    expect(ownFactory).toContain('stateLabel: item.canDecide ? "待审批" : "仅查看"');
    expect(external).toContain('"已逾期"');
    expect(external).toContain('"待处理"');
    expect(external).toContain('"仅查看"');
  });
});
