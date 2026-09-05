export type ProductionProgressState = "pending_first_report" | "normal" | "behind" | "high_risk" | "stale" | "completed";
export type ProductionProgressFacts = {
  status: "in_production" | "production_completed" | "shipped";
  quantity: number; completedQuantity: number; firstReportedOn: string | null;
  deliveryDate: string | null; lastUpdatedAt: string | null; completedOn: string | null;
};
const DAY = 86400000;
const epoch = (day: string) => Date.parse(`${day}T00:00:00Z`);
export const shanghaiDay = (at: string | Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date(at));
export const naturalDaysBetween = (start: string, end: string) => Math.max(0, Math.round((epoch(end) - epoch(start)) / DAY));
export function inclusiveWorkdays(start: string, end: string): number {
  if (end < start) return 0;
  const days = naturalDaysBetween(start, end) + 1;
  let count = Math.floor(days / 7) * 5;
  const weekday = new Date(epoch(start)).getUTCDay();
  for (let i = 0; i < days % 7; i++) if ((weekday + i) % 7 !== 0 && (weekday + i) % 7 !== 6) count++;
  return count;
}
const clamp = (value: number) => Math.max(0, Math.min(100, value));
export function calculateProductionProgress(facts: ProductionProgressFacts, asOf: string) {
  const day = shanghaiDay(asOf);
  const frozen = facts.status !== "in_production";
  const at = frozen ? facts.completedOn ?? day : day;
  const productionProgress = clamp(facts.quantity > 0 ? facts.completedQuantity / facts.quantity * 100 : 0);
  const start = facts.firstReportedOn;
  const due = facts.deliveryDate;
  const plannedWorkdays = start && due ? inclusiveWorkdays(start, due) : null;
  const elapsedWorkdays = start && due ? inclusiveWorkdays(start, at < due ? at : due) : null;
  // A weekend-only or already-expired plan has no working-day denominator.
  const timeProgress = !start || !due ? null : plannedWorkdays === 0
    ? (at >= due ? 100 : 0) : clamp(elapsedWorkdays! / plannedWorkdays! * 100);
  const lag = timeProgress === null ? null : timeProgress - productionProgress;
  const daysWithoutUpdate = !frozen && start && facts.lastUpdatedAt
    ? naturalDaysBetween(shanghaiDay(facts.lastUpdatedAt), day) : null;
  const progressState: ProductionProgressState = frozen ? "completed" : !start ? "pending_first_report"
    : daysWithoutUpdate !== null && daysWithoutUpdate >= 2 ? "stale"
    : lag === null || lag <= 1e-9 ? "normal" : lag <= 20 + 1e-9 ? "behind" : "high_risk";
  return { productionProgress, timeProgress, plannedWorkdays, elapsedWorkdays, progressState, daysWithoutUpdate,
    frozen, firstReportedOn: start, completedQuantity: facts.completedQuantity, lastUpdatedAt: facts.lastUpdatedAt,
    attention: ["stale", "high_risk", "behind"].includes(progressState) };
}
export const productionProgressRank = (state: ProductionProgressState) =>
  ({ stale: 0, high_risk: 1, behind: 2, normal: 3, pending_first_report: 4, completed: 5 })[state];
