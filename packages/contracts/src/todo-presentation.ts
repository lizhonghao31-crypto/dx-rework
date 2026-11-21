import type { TodoResponse } from "./todos.js";

/** The actual primary card headings; shared with search so visible text remains searchable. */
export const todoRouteTaskLabels: Readonly<Record<TodoResponse["route"]["routeName"], string>> = {
  rework_detail: "查看返工单",
  process_configuration: "配置或审核返工工序",
  whole_order_review: "审核整张返工单",
  responsibility_detail: "处理责任判定",
  own_factory_approval: "查看历史本厂审批",
  external_responsibility_detail: "记录供应商实际扣款",
  wage_period_detail: "核对返工工资",
  sourcing_detail: "处理外发定价选厂订单",
  digital_production_instruction: "大货制单",
  digital_production_closure: "办理本单回货质检",
  digital_bulk_washing: "办理大货洗水",
  digital_factory_progress: "记录QC生产进度与现场照片",
  digital_bulk_preparation: "办理产前准备",
  digital_source_material_investment: "投面辅料",
  digital_order_material_investment: "投面辅料",
  digital_development_arrangement: "安排本轮师傅",
  digital_development: "查看开发单",
  digital_short_lead: "办理短交期正式单特批",
  digital_order_time: "办理本单时效",
  digital_order_quotation: "填写本单工艺报价",
  digital_production_task: "办理数字生产任务",
  production_detail: "查看生产风险",
  sample_detail: "处理样衣事项",
  pattern_room_order: "处理板房订单",
  supplier_onboarding: "处理供应商申请",
};

export const todoTaskHeadingOverrides: Readonly<Record<string, string>> = {
  sourcing_contract_return: "回传合同",
  owner_signature: "老板确认签字",
  tail_inspection: "历史整查报数",
  external_supplier_selection: "历史供应商选择",
};

export const todoTaskTitle = (todo: Pick<TodoResponse, "route" | "category" | "taskTitle">): string =>
  ["digital_production_task","digital_short_lead","digital_order_time","digital_order_quotation","digital_bulk_washing"].includes(todo.route.routeName) && todo.taskTitle
    ? todo.taskTitle
    : todoTaskHeadingOverrides[todo.category] ?? todoRouteTaskLabels[todo.route.routeName];

export type TodoPresentationDeliveryKind =
  | "create"
  | "information"
  | "update"
  | "reminder"
  | "escalation";

export type TodoPresentationOrderContext = Readonly<{
  reworkNo: string | null;
  orderNo: string | null;
  styleNo: string | null;
}>;

export type TodoPresentation = Readonly<{
  title: string;
  action: string;
}>;

const catalog: Readonly<Record<string, TodoPresentation>> = {
  digital_short_lead_approval:{title:"审批短交期正式单特批",action:"核对本次客户、PO、数量、约定日期和申请理由；批准后仍须原设计师正式确认。"},
  digital_short_lead_confirmation:{title:"回原单继续正式确认",action:"核对本单批准状态，在原来源继续发布和正式确认；不要新建另一来源。"},
  digital_order_time_apply:{title:"调整本单时效",action:"按本单实际流程调整用时，提交后直接生效。"},
  digital_order_time_request:{title:"接续本单时效申请",action:"保留原单资料，核对本次变化后提交。"},
  sourcing_price_contract_return:{title:"调价合同待签回",action:"请下载当前调价合同，签署后回传对应版本。下载不会完成待办。"},
  sourcing_price_owner_approve:{title:"价格重新申请待审批",action:"请核对当前价格基准和重新申请价格。"},
  sourcing_transfer_contract_return: { title: "转厂合同待签回", action: "请下载当前转厂合同，签署后回传对应版本。下载不会完成待办。" },
  sourcing_contract_return: { title: "回传合同", action: "老板已批准，请与供应商签署合同并上传回签文件。" },
  sample_borrow_confirm: { title: "确认样衣借出", action: "请实际交付样衣后，扫描申请人的交接码确认。" },
  sample_return_confirm: { title: "确认样衣归还", action: "请实际收到样衣后，扫描申请人的交接码并填写在库位置。" },
  process_configuration: { title: "配置返工工序", action: "请配置工序、计划数量和单价。" },
  process_configuration_return: { title: "返工方案已退回", action: "请修改返工方案后重新提交。" },
  process_configuration_rejection_notice: { title: "返工方案退回通知", action: "请查看退回结果和处理记录。" },
  configuration_notice: { title: "返工单已提交", action: "请查看返工单最新状态。" },
  ie_review: { title: "审核返工方案", action: "请审核工序、数量、单位和单价。" },
  task_assignment: { title: "分配返工人员", action: "请为返工工序分配作业人员。" },
  work_reporting: { title: "登记返工完成数量", action: "请登记本次实际完成数量和时间。" },
  whole_order_review: { title: "确认返工最终数量", action: "请核对工人上数、整查数并提交最终确认数量。" },
  final_quantity_ie_review: { title: "IE 复核最终数量", action: "请复核尾部确认的数量与质量事实，或填写原因退回。" },
  work_report_return: { title: "返工上数被退回", action: "请修正被退回的完成数量记录后重新提交。" },
  quantity_adjustment: { title: "审核返工数量调整", action: "请核对异常数量调整申请。" },
  responsibility_determination: { title: "责任判定与资料核验", action: "请核对责任方、比例、供应商和倍率。" },
  responsibility_finalized_notice: { title: "返工责任判定已完成", action: "请查看本单责任方、比例和后续处理状态。" },
  high_multiplier_confirmation: { title: "确认高倍率责任", action: "请核对高倍率责任项目并作出确认。" },
  owner_signature: { title: "老板确认签字", action: "请确认整套责任事实，或直接驳回供应链总监。" },
  own_factory_approval: { title: "查看历史本厂审批", action: "请查看历史本厂责任审批记录。" },
  external_supplier_selection: { title: "补充历史供应商资料", action: "请为历史责任台账补充实际供应商。" },
  external_business_signoff: { title: "核对历史外部责任资料", action: "请核对历史外部责任资料。" },
  external_business_signoff_submitted: { title: "外部责任资料已提交", action: "资料已提交应付处理，请查看最新状态。" },
  external_payables_confirmation: { title: "确认历史应付资料", action: "请核对历史应付资料。" },
  external_payables_accepted: { title: "外部责任资料已接收", action: "应付已接收资料并进入供应商扣款跟进。" },
  external_payables_return: { title: "外部责任资料已退回", action: "请修正历史外部责任资料。" },
  external_payables_returned: { title: "外部责任资料退回结果", action: "应付已退回资料，请查看退回结果。" },
  external_deduction_follow_up: { title: "跟进供应商实际扣款", action: "请记录本次实际扣款或最新跟进结果。" },
  external_deduction_special_approval: { title: "审核扣款异常特批", action: "请确认或退回本次超额、部分扣款或未扣异常。" },
  external_deduction_special_return: { title: "处理财务总监退回", action: "请继续跟进供应商扣款，再次提交特批或完成全额扣款。" },
  external_deduction_special_approved: { title: "扣款异常特批已确认", action: "财务总监已确认该扣款异常并关闭台账。" },
  external_deduction_special_returned: { title: "扣款异常特批已退回", action: "财务总监已退回该扣款异常。" },
  external_deduction_overdue: { title: "供应商扣款跟进逾期", action: "请尽快更新供应商扣款进展。" },
  external_responsibility: { title: "记录供应商实际扣款", action: "请记录供应商实际扣款或最新跟进结果。" },
  wage_month_close: { title: "返工工资待月结", action: "请在自然月结束后锁定本月返工工资。" },
  todo_escalation: { title: "返工待办升级提醒", action: "请查看逾期事项并协调处理。" },
  recipient_routing_exception: { title: "处理待办分配异常", action: "请为无法自动分配的待办选择处理人。" },
};

const fallback: TodoPresentation = {
  title: "返工业务待办",
  action: "请进入返工系统查看并处理。",
};

/** Existing notification titles, also used to identify the same categories in reports/search. */
export const todoCategoryTitles: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(catalog).map(([category, presentation]) => [category, presentation.title]),
);

export const todoPresentationForCategory = (category: string): TodoPresentation =>
  catalog[category] ?? fallback;

const overdueCategories = new Set([
  "external_deduction_overdue",
  "todo_escalation",
]);

const deliveryPrefix = (kind: TodoPresentationDeliveryKind, category: string): string =>
  kind === "escalation" || overdueCategories.has(category)
    ? "逾期："
    : kind === "reminder"
      ? "提醒："
      : "";

const value = (input: string | null): string => input?.trim() || "未填写";

const orderSubject = (input: TodoPresentationOrderContext | null | undefined): string =>
  input
    ? `【款号:${value(input.styleNo)}｜返工单:${value(input.reworkNo)}】`
    : "";

export const buildTodoPresentation = (input: Readonly<{
  category: string;
  deliveryKind: TodoPresentationDeliveryKind;
  orderContext?: TodoPresentationOrderContext | null;
  wagePeriodMonth?: string | null;
}>): Readonly<{ subject: string; description: string }> => {
  const presentation = todoPresentationForCategory(input.category);
  const isSourcingReturn = input.category === "sourcing_contract_return";
  const contextLines = input.orderContext
    ? isSourcingReturn
      ? [`款号：${value(input.orderContext.styleNo)}`]
      : [
          `款号：${value(input.orderContext.styleNo)}`,
          `返工单：${value(input.orderContext.reworkNo)}`,
        ]
    : input.wagePeriodMonth
      ? [`工资月份：${input.wagePeriodMonth.slice(0, 7)}`]
      : [];
  return {
    subject: `${deliveryPrefix(input.deliveryKind, input.category)}${isSourcingReturn && input.orderContext ? `【款号:${value(input.orderContext.styleNo)}】` : orderSubject(input.orderContext)}${presentation.title}`,
    description: [...contextLines, `事项：${presentation.action}`].join("\n"),
  };
};
