import type { CommandOrder, CommandSummary } from "./production-command-center-view.js";

export const PRODUCTION_COMMAND_CENTER_DEMO_SUMMARY: CommandSummary = {
  active: 38, dueSoon: 7, highRisk: 3, overdue: 2, normal: 26, completed: 12,
};

export const PRODUCTION_COMMAND_CENTER_DEMO_ORDERS: readonly CommandOrder[] = [
  { orderNo: "MO-260928-001", styleNo: "DX2609281", customer: "SE", category: "女装 · 连衣裙", styleName: "拼接连衣裙", orderType: "大货", progress: 60, merchandiser: "黄建华", designer: "李阳阳", quantity: "1,308件", deliveryDate: "2026-10-16", currentStage: "裁床开裁", nodeEnteredAt: "09-28 08:00", nodeLimit: "24小时", nodeDeadline: "09-29 08:00", nodeRemaining: "剩余 6小时", nodeRisk: "attention", overallRisk: "high", overallRiskText: "预计晚 1天", reason: "关键辅料预计晚于裁床需要时间，若不调整将影响后续二次工艺与发厂。" },
  { orderNo: "MO-260928-002", styleNo: "DX2609273", customer: "PD", category: "男装 · 上衣", styleName: "针织上衣", orderType: "开发板", progress: 30, merchandiser: "陈洁", designer: "王敏", quantity: "—", deliveryDate: "—", currentStage: "纸样制作", nodeEnteredAt: "09-27 15:00", nodeLimit: "48小时", nodeDeadline: "09-29 15:00", nodeRemaining: "剩余 20小时", nodeRisk: "attention", overallRisk: "normal", overallRiskText: "正常", reason: "当前已知条件下未发现交付风险。" },
  { orderNo: "MO-260927-009", styleNo: "DX2609219", customer: "GA", category: "女装 · 裤子", styleName: "休闲裤", orderType: "大货", progress: 40, merchandiser: "刘洁华", designer: "周琪", quantity: "850件", deliveryDate: "2026-10-12", currentStage: "印花加工", nodeEnteredAt: "09-26 10:30", nodeLimit: "36小时", nodeDeadline: "09-27 22:30", nodeRemaining: "已超时 9小时", nodeRisk: "overdue", overallRisk: "attention", overallRiskText: "需关注", reason: "当前节点已经超时，但整单仍有可追回余量。" },
  { orderNo: "MO-260927-004", styleNo: "DX2609202", customer: "PA", category: "男装 · 衬衫", styleName: "POLO衫", orderType: "开发板", progress: 10, merchandiser: "林洁", designer: "陈敏", quantity: "—", deliveryDate: "—", currentStage: "文员核配", nodeEnteredAt: "—", nodeLimit: "待前序", nodeDeadline: "待前序完成后生成", nodeRemaining: "未计时", nodeRisk: "unknown", overallRisk: "normal", overallRiskText: "正常", reason: "尚未进入后续节点，不提前启动节点时钟。" },
  { orderNo: "MO-260926-006", styleNo: "DX2609188", customer: "ST", category: "男装 · 卫衣", styleName: "连帽卫衣", orderType: "大货", progress: 20, merchandiser: "黄建华", designer: "李阳阳", quantity: "2,400件", deliveryDate: "2026-10-20", currentStage: "仓库预缩", nodeEnteredAt: "09-28 09:00", nodeLimit: "24小时", nodeDeadline: "09-29 09:00", nodeRemaining: "剩余 7小时", nodeRisk: "normal", overallRisk: "normal", overallRiskText: "正常", reason: "当前按计划推进。" },
];

export const PRODUCTION_COMMAND_CENTER_DEMO_SELECTED = "MO-260928-001";
