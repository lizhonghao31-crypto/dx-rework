export function canReadProductionAnalysis(user:{isRoot?:boolean;businessRoles?:readonly string[];capabilities:readonly string[]}) {
  const roles=user.businessRoles??[];
  return user.isRoot===true || (roles.some(role=>["owner_group","production_management","order_merchandiser","finance_director","finance_read"].includes(role)) && user.capabilities.includes("sourcing:view"))
    || (roles.includes("production_reporter") && user.capabilities.includes("production-reporting"));
}
export const productionAnalysisDueLabels = {all:"全部交期",overdue:"已逾期未完",soon:"未来7自然日到期",missing:"未完缺交期",later:"更晚交期",closed:"完成或已发货"};
export const productionAnalysisReceivingLabels = {none:"尚无有效实收",partial:"已记录部分实收",quantity_met:"实收数量达到发货记录",unverified:"批次调整待核查"};
