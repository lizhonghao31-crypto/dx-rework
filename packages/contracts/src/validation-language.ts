import { z } from "zod";
import { zhCN } from "zod/locales";

const labels: Record<string, string> = {
  inspectionLocation: "验货地点", inspectionStage: "验货阶段", inspectionDate: "验货日期", sampleQuantity: "抽检数量",
  nonconformanceCause: "不合格原因", sizeSamples: "抽检尺码", measurements: "测量记录", actualCm: "实测值", deviationCm: "偏差",
  documentChecks: "资料核对", exceptionReason: "缺少资料原因", physicalPerformance: "物理性能",
  documents: "资料核对", fabricMatch: "面料核对结果", fabricMismatchReason: "面料不符原因", fitDecision: "试身结论",
  factoryPreparation: "工厂准备情况", materialChecks: "面辅料检查", washTest: "洗水测试", productMarking: "产品标识",
  issues: "问题记录", category: "类别", majorCount: "严重问题数量", minorCount: "轻微问题数量",
  scopeId: "授权范围对象", validFrom: "有效开始时间", validUntil: "有效结束时间",
  shareBps: "责任比例", responsibilityType: "责任类型", multiplier: "责任倍数", allocations: "责任分摊",
  processId: "工序", configurationItemId: "工序", workers: "工人", members: "任务成员", entries: "扣款记录",
  reworkOrderId: "返工单", returnedQuantity: "回货数量", processCount: "工序数量", quantityUnit: "计价单位",
  name: "名称", title: "标题", description: "说明", note: "备注", remark: "备注", reason: "原因",
  styleNo: "款号", styleName: "款名", orderNo: "订单号", poNumber: "PO号", temporaryStyleNo: "临时款号",
  customerId: "客户", customerName: "客户", sourceId: "开发档案", orderId: "订单", taskId: "任务",
  supplierId: "加工厂", factoryId: "工厂", employeeId: "人员", userId: "人员", assigneeId: "办理人",
  workerId: "工人", designerId: "设计师", primaryMerchandiserId: "主跟单", categoryId: "类别",
  quantity: "数量", plannedQuantity: "计划数量", actualQuantity: "实际数量", finalQuantity: "最终数量",
  unitPrice: "单价", price: "价格", amount: "金额", hours: "工时", rate: "费率", discount: "折扣",
  customerRequiredDate: "客户交期", factoryPlannedDate: "工厂计划交期", requiredDate: "要求日期",
  targetDate: "目标日期", deadline: "截止时间", date: "日期", from: "开始日期", to: "结束日期",
  color: "颜色", size: "尺码", sizes: "尺码", materials: "面辅料", processes: "工序", items: "明细",
  attachments: "附件", attachmentId: "附件", fileName: "文件名", mimeType: "文件类型",
  status: "状态", kind: "类型", unit: "单位", role: "角色", roles: "角色", page: "页码", limit: "每页条数",
  search: "搜索关键词", q: "搜索关键词", id: "关联记录", phone: "手机号", email: "邮箱",
};

export function validationFieldLabel(path: readonly PropertyKey[]): string {
  return path.map(key => typeof key === "number" ? `第${key + 1}行` : labels[String(key)] ?? "填写内容").join(" / ") || "提交资料";
}

/** Configure at application bootstrap; schemas and all existing custom business messages stay authoritative. */
export function configureChineseValidation(): void {
  const locale = zhCN();
  z.config({ localeError: issue => {
    const reason = issue.code === "invalid_value" ? "请选择已有的有效选项"
      : issue.code === "invalid_type" ? "请填写有效内容，注意数值或文字格式"
      : locale.localeError(issue);
    return `${validationFieldLabel(issue.path ?? [])}：${reason}`;
  } });
}

export function requestValidationMessage(result: { error?: { issues?: readonly { path?: readonly PropertyKey[]; message?: string }[] } }): string {
  const issues = result.error?.issues ?? [];
  if (!issues.length) return "提交资料格式不正确，请检查填写内容";
  return issues.slice(0, 6).map(issue => {
    const label = validationFieldLabel(issue.path ?? []);
    const message = issue.message ?? "请检查填写内容";
    return message.startsWith(`${label}：`) ? message : `${label}：${message}`;
  }).join("；");
}
