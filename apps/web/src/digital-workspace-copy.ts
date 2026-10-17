import type {DigitalTask} from '@dx-rework/contracts/digital-production-tasks';
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

/** A resource pause does not change the persisted task state. */
export function digitalTaskDisplayStatus(task:Pick<DigitalTask,'state'|'paused'>,readOnly=false):string {
  const label=task.paused&&!['completed','cancelled'].includes(task.state)?'已暂停':digitalTaskStateLabels[task.state];
  return readOnly&&!['completed','cancelled'].includes(task.state)?`${task.state==='ready'&&!task.paused?'待办理':label} · 只读`:label;
}
export function digitalTaskObjectLabel(task:Pick<DigitalTask,'orderId'|'sourceId'>):string {
  return task.orderId?'大货任务':task.sourceId?'开发任务':'数字生产任务';
}
