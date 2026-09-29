import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ProductionCommandCenterView, type CommandOrder } from "../../apps/web/src/production-command-center-view.js";

const order: CommandOrder = {
  orderNo: "MO-TEST-001", styleNo: "DX-TEST-001", customer: "SE", category: "女装 · 连衣裙",
  merchandiser: "测试跟单", designer: "测试设计师", quantity: "1,000件", deliveryDate: "2026-10-16",
  currentStage: "开裁", nodeEnteredAt: "09-28 08:00", nodeLimit: "24小时", nodeDeadline: "09-29 08:00",
  nodeRemaining: "剩余 6小时", nodeRisk: "attention", overallRisk: "high", overallRiskText: "预计晚 1天",
  reason: "关键辅料晚于需要时间",
};

describe("production command center presentation", () => {
  it("keeps node deadline and overall delivery risk as separate visible facts", () => {
    const html = renderToStaticMarkup(createElement(ProductionCommandCenterView, { summary: { active: 1, dueSoon: 1, highRisk: 1, overdue: 0 }, orders: [order], selectedOrderNo: order.orderNo }));
    for (const value of ["进入时间", "标准时限", "完成期限", "09-29 08:00", "剩余 6小时", "整单交付风险", "预计晚 1天"]) expect(html).toContain(value);
  });

  it("does not represent future nodes as already timed work", () => {
    const html = renderToStaticMarkup(createElement(ProductionCommandCenterView, { summary: { active: 1, dueSoon: 1, highRisk: 1, overdue: 0 }, orders: [{ ...order, currentStage: "待二次工艺", nodeEnteredAt: "—", nodeLimit: "待前序", nodeDeadline: "待前序完成后生成", nodeRemaining: "未计时", nodeRisk: "unknown" }], selectedOrderNo: order.orderNo }));
    expect(html).toContain("待前序完成后生成");
    expect(html).toContain("未计时");
    expect(html).toContain("未进入的后续节点不提前倒计时");
  });

  it("renders the approved cockpit visual anatomy in the real component", () => {
    const html = renderToStaticMarkup(createElement(ProductionCommandCenterView, { summary: { active: 38, dueSoon: 7, highRisk: 3, overdue: 2, normal: 26, completed: 12 }, orders: [order], selectedOrderNo: order.orderNo }));
    for (const value of ["生产管理座舱", "开发管理", "大货生产", "实时生产看板", "今日待处理", "全部订单", "订单进度总览", "风险提示", "相关人员", "生产进度", "当前节点详情"]) expect(html).toContain(value);
    expect(html).toContain("production-command-topbar");
    expect(html).toContain("production-command-detail-aside");
  });
});
