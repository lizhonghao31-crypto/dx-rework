export function digitalDeadline(enteredAt: Date | string | null, slaSeconds: number | null, warningRatio: number): { warningAt: Date | null; dueAt: Date | null } {
  if (!Number.isFinite(warningRatio) || warningRatio <= 0 || warningRatio >= 1) throw new Error("Invalid warning ratio");
  if (slaSeconds !== null && (!Number.isFinite(slaSeconds) || slaSeconds <= 0)) throw new Error("Invalid SLA");
  if (enteredAt === null || slaSeconds === null) return { warningAt: null, dueAt: null };
  const entered = new Date(enteredAt).getTime();
  if (!Number.isFinite(entered)) throw new Error("Invalid entry time");
  return { warningAt: new Date(entered + slaSeconds * warningRatio * 1000), dueAt: new Date(entered + slaSeconds * 1000) };
}
export function digitalTaskTiming(input: { slaHours: number | null; enteredAt: string | null; completedAt: string | null; terminal: boolean; dueAt: string | null; warningAt: string | null; deadlineExclusive?:boolean }, now: Date) {
  const entered = input.enteredAt ? new Date(input.enteredAt).getTime() : null;
  const end = input.completedAt ? new Date(input.completedAt).getTime() : now.getTime();
  if(!Number.isFinite(end)||!Number.isFinite(now.getTime())||entered!==null&&(!Number.isFinite(entered)||end<entered)||input.completedAt&&end>now.getTime())return {state:"unknown" as const,elapsedSeconds:null,onTime:null};
  const elapsedSeconds = entered === null ? null : Math.floor((end - entered) / 1000);
  if (input.terminal && input.completedAt === null) return { state: "unknown" as const, elapsedSeconds: null, onTime: null };
  if (entered === null && input.slaHours !== null) return { state: "unknown" as const, elapsedSeconds: null, onTime: null };
  if (input.dueAt === null) return { state: "unlimited" as const, elapsedSeconds, onTime: null };
  const due = new Date(input.dueAt).getTime();
  const onTime=input.deadlineExclusive===true?end<due:end<=due;
  if (input.terminal) return { state: onTime ? "completed_on_time" as const : "completed_overdue" as const, elapsedSeconds, onTime };
  const overdue=input.deadlineExclusive===false?end>due:end>=due;
  return { state: overdue ? "overdue" as const : input.warningAt && end >= new Date(input.warningAt).getTime() ? "attention" as const : "normal" as const, elapsedSeconds, onTime: null };
}
