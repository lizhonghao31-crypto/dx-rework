export type ProductionNodeClockState =
  | "normal"
  | "attention"
  | "overdue"
  | "completed_on_time"
  | "completed_overdue";

export type ProductionNodeClockFacts = Readonly<{
  enteredAt: string | Date;
  warningAt: string | Date;
  dueAt: string | Date;
  completedAt: string | Date | null;
}>;

const epoch = (value: string | Date): number => new Date(value).getTime();

export function classifyProductionNodeClock(
  facts: ProductionNodeClockFacts,
  asOf: string | Date,
): Readonly<{
  state: ProductionNodeClockState;
  secondsToDeadline: number;
  completed: boolean;
}> {
  const entered = epoch(facts.enteredAt);
  const warning = epoch(facts.warningAt);
  const due = epoch(facts.dueAt);
  const now = epoch(asOf);
  const completed = facts.completedAt === null ? null : epoch(facts.completedAt);

  if (![entered, warning, due, now, ...(completed === null ? [] : [completed])].every(Number.isFinite)) {
    throw new Error("Production node clock requires valid timestamps");
  }
  if (warning < entered || due < warning || (completed !== null && completed < entered)) {
    throw new Error("Production node clock timestamps are out of order");
  }

  if (completed !== null) {
    return {
      state: completed <= due ? "completed_on_time" : "completed_overdue",
      secondsToDeadline: Math.trunc((due - completed) / 1000),
      completed: true,
    };
  }

  return {
    state: now >= due ? "overdue" : now >= warning ? "attention" : "normal",
    secondsToDeadline: Math.trunc((due - now) / 1000),
    completed: false,
  };
}
