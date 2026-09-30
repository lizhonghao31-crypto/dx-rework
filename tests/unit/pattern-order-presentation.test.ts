import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PatternOrderSummary } from "@dx-rework/contracts/pattern-orders";
import { PatternOrderCard } from "../../apps/web/src/pattern-order-card.js";
import { PatternRoundRecord } from "../../apps/web/src/pattern-round-record.js";
import { patternNodeQuery, patternSelectedStage, patternWorkflow, type PatternRound } from "../../apps/web/src/pattern-workflow.js";

const time = "2026-09-15T08:00:00Z";
const order: PatternOrderSummary = { orderId: "order-test", orderNo: "BF-TEST-001", kind: "pattern", taskName: null, status: "pending_assignment", version: 1, styleNo: "TEST-衬衫", creatorId: "creator", creatorName: "测试设计师", currentWorkerName: null, requiredDate: "2026-09-24", reworkCount: 0, submittedAt: time, updatedAt: time };
const round: PatternRound = { roundId: "round-test", index: 0, roundType: "initial", requestedBy: "creator", requestReason: null, status: "in_progress", categoryName: "衬衫", unit: "件", quantity: 2, assignedAt: time, completedAt: null, handedOverAt: null, stoppedAt: null, cancelledAt: null, feeConfirmedAt: null, segments: [], nodes: [
  { stage: "pending_assignment", enteredAt: time, exitedAt: time, exitReason: "advanced", elapsedSeconds: 30 },
  { stage: "in_progress", enteredAt: time, exitedAt: null, exitReason: null, elapsedSeconds: 60 },
] };

describe("pattern room order presentation", () => {
  it.each(["pattern", "misc"] as const)("makes the complete %s card body a single native link and keeps deletion outside it", kind => {
    const href = "/rework/ui/pattern-room/orders/order-test?returnTo=%2Fui%2Fpattern-room%2Forders%3Fpage%3D3";
    const html = renderToStaticMarkup(createElement(PatternOrderCard, { order: { ...order, kind, taskName: "测试杂事任务" }, href, canDelete: true, busy: false, onDeleted() {} }));
    const link = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/g)!;
    expect(link).toHaveLength(1);
    for (const value of [kind === "misc" ? "测试杂事任务" : order.styleNo, order.orderNo, order.creatorName, "要求完成", "提交时间"]) expect(link[0]).toContain(value);
    expect(link[0]).toContain(`href="${href}"`);
    expect(link[0]).not.toContain("<button");
    expect(html.indexOf('aria-label="删除订单')).toBeGreaterThan(html.indexOf("</a>"));
    expect(html).toContain('<svg viewBox="0 0 24 24" aria-hidden="true">');
  });

  it("omits deletion without permission and disables it during refresh", () => {
    const props = { order, href: "/detail", canDelete: false, busy: false, onDeleted() {} };
    expect(renderToStaticMarkup(createElement(PatternOrderCard, props))).not.toContain("删除订单");
    const busy = renderToStaticMarkup(createElement(PatternOrderCard, { ...props, canDelete: true, busy: true }));
    expect(busy).toMatch(/<button[^>]*disabled=""/);
  });

  it("distinguishes cancelled work from completed predecessors and unexecuted successors", () => {
    const cancelled: PatternRound = { ...round, status: "cancelled", cancelledAt: time, nodes: round.nodes.map(node => node.stage === "in_progress" ? { ...node, exitedAt: time, exitReason: "cancelled" } : node) };
    expect(patternWorkflow(cancelled, false).map(item => [item.state, item.status])).toEqual([
      ["completed", "已完成"], ["stopped", "已终止"], ["future", "未执行"], ["cancelled", "已取消"],
    ]);
    expect(patternWorkflow(cancelled, false).some(item => item.stage === "completed")).toBe(false);
  });

  it("shows the handoff interrupted by rework without claiming a successful handoff", () => {
    const historical: PatternRound = { ...round, status: "pending_confirmation", stoppedAt: null, nodes: [{ stage: "pending_confirmation", enteredAt: time, exitedAt: time, exitReason: "rework", elapsedSeconds: 50 }] };
    expect(patternWorkflow(historical, false)[2]).toMatchObject({ state: "stopped", status: "已转入返工" });
    expect(patternWorkflow(historical, false)[3]).toMatchObject({ state: "future", status: "未执行" });
    expect(patternWorkflow({ ...round, status: "completed" }, true)[3]).toMatchObject({ state: "completed", status: "已完成" });
  });

  it("preserves history and return context when navigating nodes and defaults safely for every order status", () => {
    const search = "?round=old-round&segment=old-worker&returnTo=%2Fui%2Fmy-tasks%3Fpage%3D3";
    const target = patternNodeQuery(search, "pending_assignment");
    const params = new URLSearchParams(target.slice(1).split("#")[0]);
    expect(params.get("round")).toBe("old-round");
    expect(params.get("segment")).toBe("old-worker");
    expect(params.get("returnTo")).toBe("/ui/my-tasks?page=3");
    expect(patternSelectedStage(round, target.split("#")[0]!)).toBe("pending_assignment");
    for (const status of ["pending_assignment", "in_progress", "pending_confirmation", "completed", "cancelled"] as const) {
      expect(patternSelectedStage({ ...round, status }, "?node=unknown")).toBe(status);
    }
  });

  it("renders independent execution records and does not invent prices hidden by the API", () => {
    const segment = { segmentId: "segment-test", personId: "person-test", workerUserId: "worker-test", workerName: "测试师傅", actualHours: "1.5", startedAt: time, endedAt: time, wageEligible: true };
    const hidden = renderToStaticMarkup(createElement(PatternRoundRecord, { round: { ...round, segments: [segment] }, misc: true }));
    expect(hidden).toContain("测试师傅");
    expect(hidden).toContain('id="segment-segment-test"');
    expect(hidden).not.toContain("本轮价格");
    expect(hidden).not.toContain("分配金额");
    const visible = renderToStaticMarkup(createElement(PatternRoundRecord, { round: { ...round, agreedAmount: "1234.567", segments: [{ ...segment, amount: "1234.567" }] }, misc: true }));
    expect(visible).toContain("1,234.57");
  });
  it("moves summary facts without dropping worker and cancellation records or exposing hidden prices", () => {
    const data: PatternRound = { ...round, agreedAmount: "60.00", cancelledAt: time, cancelledAmount: "12.50", segments: [{ segmentId: "kept", personId: "p", workerUserId: "w", workerName: "保留师傅", actualHours: null, startedAt: time, endedAt: time, wageEligible: false }] };
    const top = renderToStaticMarkup(createElement(PatternRoundRecord, { round: data, misc: false, summaryOnly: true }));
    const history = renderToStaticMarkup(createElement(PatternRoundRecord, { round: data, misc: false, omitSummary: true }));
    expect(top).toContain("60 元");
    expect(top).not.toContain("取消费用");
    expect(history).not.toContain("本轮价格");
    expect(history).toContain("保留师傅");
    expect(history).toContain("12.5 元");
    expect(history).toContain('id="segment-kept"');
    const hidden = renderToStaticMarkup(createElement(PatternRoundRecord, { round, misc: false, summaryOnly: true }));
    expect(hidden).not.toContain("本轮价格");
  });

});
