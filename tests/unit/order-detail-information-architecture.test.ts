import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("order detail information architecture", () => {
  it("keeps the inspection report available but collapsed by default", async () => {
    const report = await readFile("apps/web/src/inspection-report-readonly.tsx", "utf8");
    expect(report).toContain('<details className="inspection-readonly"');
    expect(report).toContain('className="inspection-readonly__summary"');
    expect(report).toContain("验货报告");
    expect(report).toContain("inspection-readonly__content");
    expect(report).not.toContain('<details className="inspection-readonly" open');
  });

  it("renders the approved core facts as explicit semantic cards without nth-child field selection", async () => {
    const [detail, styles] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-compact.css", "utf8"),
    ]);
    expect(detail).toContain('className="rework-detail-core-facts"');
    expect(detail).toContain("<dt>返工工序</dt>");
    expect(detail).toContain("<dt>加工厂</dt>");
    expect(detail).toContain("<dt>发起时间</dt>");
    expect(detail).toContain("<dt>发起人</dt>");
    expect(detail).toContain("<dt>订单跟单</dt>");
    expect(detail).toContain("<dt><ReceivedQuantityLabel>实收数量</ReceivedQuantityLabel></dt>");
    expect(detail).toContain("sourceReceivingActualQuantity");
    expect(styles).toContain(".rework-detail-core-facts");
    expect(styles).toContain("grid-template-columns: repeat(7, minmax(0, 1fr));");
    expect(styles).not.toContain("nth-child");
    expect(styles).not.toContain("display: contents");
  });

  it("shows only populated optional order fields in a responsive dynamic information section", async () => {
    const [detail, styles] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-compact.css", "utf8"),
    ]);
    expect(detail).toContain("const dynamicFacts = [");
    expect(detail).toContain('{ label: "客供款号", value: detail.customerSupplyCode }');
    expect(detail).toContain('{ label: "工厂款号", value: detail.factoryStyleNo }');
    expect(detail).toContain('{ label: "订单号", value: detail.orderNo }');
    expect(detail).toContain('{ label: "问题描述", value: detail.problemDescription }');
    expect(detail).toContain('{ label: "洗水厂", value: detail.supplyContext.washingSupplierName }');
    expect(detail).toContain('{ label: "印绣花厂", value: detail.supplyContext.embroiderySupplierName }');
    expect(detail).toContain('{ label: "面辅料供应商", value: detail.supplyContext.fabricSupplierName }');
    expect(detail).toContain('{ label: "印绣花跟单", value: detail.supplyContext.embroideryMerchandiserName }');
    expect(detail).toContain("Boolean(fact.value)");
    expect(detail).toContain('className="rework-detail-dynamic-information"');
    expect(detail).toContain("仅展示本单已填写的业务字段");
    expect(styles).toContain(".rework-detail-dynamic-facts");
    expect(styles).toContain("repeat(auto-fit, minmax(180px, 1fr))");
  });

  it("uses the accepted sourcing rail without changing real node links or workspaces", async () => {
    const [detail, sourcing, governed, query, board] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/rework-governed.css", "utf8"),
      readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8"),
      readFile("apps/web/src/reporting/basic-rework-board.tsx", "utf8"),
    ]);
    expect(detail).toContain('<WorkflowRail className="rework-workflow__desktop-grid"');
    expect(detail).toContain('<WorkflowRail className="rework-workflow__mobile-rail"');
    expect(sourcing).toContain('<WorkflowRail className="sourcing-workflow-rail"');
    expect(detail).toContain('node.state === "completed" ? "✓" : Number(node.number)');
    expect(detail).toContain('<small>{node.ownerRole}</small>');
    expect(detail).not.toContain('{node.ownerName}</small>');
    expect(detail).not.toContain('rework-workflow__pending-path');
    expect(detail).toContain('reworkHistoryHref(detail.reworkOrderId, node.key) : nodeHref(detail.reworkOrderId, node.key)');
    expect(detail).toContain('useState(false)');
    expect(detail).toContain('aria-expanded={mobileWorkflowExpanded}');
    expect(detail).toContain('data-active={node.key === activeNode}');
    expect(detail).toContain(`querySelector('[data-active="true"]')`);
    expect(detail).toContain('?? (detail.status === "completed" ? detail.reworkKind === "inhouse_finishing" ? "final_quantity_ie_review" : "settlement_followup" : undefined)');
    expect(governed).toContain('repeat(5, minmax(0, 1fr))');
    expect(governed).toContain('flex-direction: row; overflow-x: auto');
    expect(governed).not.toContain('--dx-v2-color-border');
    // A detail-only stylesheet must not recapture either list or its nested metrics.
    expect(governed).not.toContain('.reporting-order');
    expect(governed).not.toContain('.reporting-filters');
    for (const list of [query, board]) {
      expect(list).toContain('className="rework-query-content"');
      expect(list).not.toContain('rework-governed');
      expect(list).not.toContain('data-dx-ui="governed"');
    }
  });

  it("renders all real images in the governed strip while preserving preview navigation", async () => {
    const [detail, styles] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-compact.css", "utf8"),
    ]);
    expect(detail).toContain("const visibleImageAttachments = imageAttachments;");
    const governed = await readFile("apps/web/src/rework-governed.css", "utf8");
    expect(governed).toContain(".rework-detail-image-card:nth-child(n+7) { display: grid; }");
    expect(governed).toContain("overflow-x: auto;");
    expect(detail).not.toContain("暂无图片");
    expect(detail).not.toContain("rework-detail-image-card--empty");
    expect(detail).not.toContain("imageAttachments.length - 5");
    expect(detail).toContain("showRelativeImage(1)");
    expect(detail).toContain("title={detail.reworkProcess ?? undefined}");
    expect(styles).toContain(".rework-detail-image-card__overflow");
  });

  it("defaults to the real active node while preserving explicit historical node links", async () => {
    const detail = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(detail).toContain('const defaultSelectedNode = activeNode ?? "settlement_followup";');
    expect(detail).toContain("const selectedNode = selectedFromUrl ?? (focusedNode === activeNode ? focusedNode : defaultSelectedNode);");
    expect(detail).not.toContain('detail.status === "pending_process_configuration" ? "initiation"');
    expect(detail).toContain('embedded onOrderChanged={() => { void syncAfterNodeAction(); }}');
  });

  it("keeps real workflow numbering and existing node workspaces instead of copying mock data", async () => {
    const detail = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(detail).toContain('node("initiation", "01", detail.reworkKind === "inhouse_finishing" ? "本厂做尾" : "发起返工"');
    expect(detail).toContain('node("process_configuration", "02", "分配工序 &工人"');
    expect(detail).toContain('node("ie_review", "03", "IE 核价"');
    expect(detail).toContain('node("work_reporting", "04", "返工执行报数"');
    expect(detail).not.toContain('node("tail_inspection"');
    expect(detail).toContain('node("whole_order_review", "05", "尾部最终数量确认"');
    expect(detail).toContain('node("final_quantity_ie_review", "06", "IE 最终数量复核"');
    expect(detail).toContain('node("responsibility", "07", "责任判定"');
    expect(detail).toContain('node("owner_signature", "08", "老板确认签字"');
    expect(detail).toContain('node("settlement_followup", "09", "返工业务完成"');
    expect(detail).not.toContain('node("task_assignment", "04", "分配返工人员"');
    expect(detail).toContain("<ProcessConfigurationForm reworkOrderId={detail.reworkOrderId}");
    expect(detail).toMatch(/<WorkReportingForm[\s\S]*?reworkOrderId=\{detail\.reworkOrderId\}/);
    expect(detail).not.toContain("<TailInspectionPanel reworkOrderId={detail.reworkOrderId}");
    expect(detail).not.toContain('if (value === "tail_inspection") return "tail_inspection";');
    expect(detail).toContain("<ResponsibilityDeterminationPanel reworkOrderId={detail.reworkOrderId}");
  });

  it("shows the latest configuration unit-price sum beside every node workspace", async () => {
    const [detail, service, styles] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
      readFile("apps/web/src/rework-detail.css", "utf8"),
    ]);
    expect(service).toContain("SELECT SUM(item.unit_price)::text");
    expect(service).toContain("singlePieceReworkTotal");
    expect(detail).toContain("单件返工总价：");
    expect(detail).toContain("detail.singlePieceReworkTotal");
    expect(styles).toContain(".rework-detail-single-piece-total");
    expect(styles).toContain("var(--dx-v2-color-primary)");
  });

  it("derives the visible rework process from the latest N02 configuration without mutating the order", async () => {
    const service = await readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8");
    expect(service).toContain("string_agg(item.process_name,'、' ORDER BY item.position)");
    expect(service).toContain("latest_configuration.process_names");
    expect(service).toContain("to_jsonb(orders)->>'rework_process'");
  });

  it("removes the unused order-number placeholder from desktop and mobile order cards", async () => {
    const card = await readFile("apps/web/src/reporting/management-order-card.tsx", "utf8");
    expect(card).toContain('<small>{order.reworkNo ?? "返工单"} · {order.reworkKind === "inhouse_finishing" ? "本厂做尾" : "QC返工"}</small>');
    expect(card).not.toContain("订单号未填写");
  });
});
