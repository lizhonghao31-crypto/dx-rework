/** Display words only: stored task states and washing choices keep their original meaning. */
export const digitalTaskStateLabels = {
  pending: "等待前置", ready: "可办理", blocked: "暂时办不了",
  completed: "已完成", cancelled: "已取消",
} as const;

export const pendingTaskTimingLabel = "等待前置，尚未开始计时";
export const unsavedInputLabel = "没有保存成功，请重试；你填的内容还在";

export function washingChoiceLabel(value: string): string {
  return value === "内洗" ? "本厂洗" : value === "外洗" ? "外厂洗" : value;
}

/** Current-screen label only; the stored fact remains the customer-agreed warehouse arrival date. */
export const customerPoDateLabel = "出货日期";

/** Display existing history kinds only; unknown events keep their saved facts and order. */
export function digitalTaskHistoryKindLabel(kind:string):string {
  const names:Record<string,string>={created:'创建任务',ready:'进入任务',completed:'完成任务',condition:'前置条件登记',time_corrected:'时间核实',policy_changed:'时效调整',pause:'暂停',resume:'恢复',cancel:'取消后续任务',cancelled:'任务已取消',blocked:'问题登记',unblocked:'解除问题登记',reassigned:'改派任务',priority_changed:'优先级调整',system_route:'系统路由'};
  return Object.hasOwn(names,kind)?names[kind]!:'任务记录';
}

/** Only known system reason codes are named; original free text is preserved. */
export function digitalTaskHistoryText(value:string):string {
  const names:Record<string,string>={bulk_requirements_changed:'批准或技术要求已变更，保留原办理记录',new_development_round:'已由新修改轮次接续，保留原办理记录'};
  return Object.hasOwn(names,value)?names[value]!:value;
}
