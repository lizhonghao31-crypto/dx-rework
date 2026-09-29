export function digitalDeadline(enteredAt: Date | string | null, slaSeconds: number | null, warningRatio: number): { warningAt: Date | null; dueAt: Date | null } {
  if (!Number.isFinite(warningRatio) || warningRatio <= 0 || warningRatio >= 1) throw new Error("Invalid warning ratio");
  if (slaSeconds !== null && (!Number.isFinite(slaSeconds) || slaSeconds <= 0)) throw new Error("Invalid SLA");
  if (enteredAt === null || slaSeconds === null) return { warningAt: null, dueAt: null };
  const entered = new Date(enteredAt).getTime();
  if (!Number.isFinite(entered)) throw new Error("Invalid entry time");
  return { warningAt: new Date(entered + slaSeconds * warningRatio * 1000), dueAt: new Date(entered + slaSeconds * 1000) };
}
export function digitalTaskTiming(input: { enteredAt: string | null; completedAt: string | null; terminal: boolean; dueAt: string | null; warningAt: string | null }, now: Date) {
  const entered = input.enteredAt ? new Date(input.enteredAt).getTime() : null;
  const end = input.completedAt ? new Date(input.completedAt).getTime() : now.getTime();
  const elapsedSeconds = entered === null ? null : Math.max(0, Math.floor((end - entered) / 1000));
  if (input.terminal && input.completedAt === null) return { state: "unknown" as const, elapsedSeconds: null, onTime: null };
  if (input.dueAt === null) return { state: "unlimited" as const, elapsedSeconds, onTime: null };
  const due = new Date(input.dueAt).getTime();
  if (input.terminal) return { state: end <= due ? "completed_on_time" as const : "completed_overdue" as const, elapsedSeconds, onTime: end <= due };
  return { state: end >= due ? "overdue" as const : input.warningAt && end >= new Date(input.warningAt).getTime() ? "attention" as const : "normal" as const, elapsedSeconds, onTime: null };
}
