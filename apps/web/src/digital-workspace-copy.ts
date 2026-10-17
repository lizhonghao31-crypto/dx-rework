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
export const customerPoDateLabel = "客户仓到货日";
