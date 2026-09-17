import { WorkflowAnalysisResponseSchema, type WorkflowAnalysisQuery, type WorkflowAnalysisResponse } from "@dx-rework/contracts";

type Item = WorkflowAnalysisResponse["items"][number];
type Transition = Item["history"][number];
const closed = (row: Pick<Item, "status">) => ["completed", "closed", "cancelled"].includes(row.status);
const NODE_ORDER = [
  "draft",
  "pending_process_configuration",
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_final_quantity_ie_review",
  "pending_quantity_adjustment_ie_review",
  "pending_responsibility_determination",
  "pending_owner_signature",
  "pending_responsibility_action",
] as const;
const dayStart = (day: string) => Date.parse(`${day}T00:00:00+08:00`);
const dayEnd = (day: string) => Date.parse(`${day}T23:59:59.999+08:00`);
const instant = (value: string | null) => value ? Date.parse(value) : Number.NaN;
const average = (values: readonly number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

function changedHistory(row: Item): Transition[] {
  return row.history.filter(event => event.changesNode && event.enteredAt !== null)
    .sort((a, b) => (a.enteredAt ?? "").localeCompare(b.enteredAt ?? "") || a.id.localeCompare(b.id));
}

function periodSummary(rows: Item[], filters: WorkflowAnalysisQuery): WorkflowAnalysisResponse["periodSummary"] {
  if (filters.periodMode !== "activity" || !filters.from || !filters.to) return null;
  const start = dayStart(filters.from), end = dayEnd(filters.to);
  let enteredCount = 0, completedCount = 0, openAtEndCount = 0, missingCycleCount = 0;
  const cycles: number[] = [];
  let longestOpenSeconds: number | null = null, longestOpenItemId: string | null = null;
  const nodeValues = new Map<string, { completed: number[]; open: { seconds: number; id: string }[]; missing: number }>();
  for (const node of NODE_ORDER) nodeValues.set(node, { completed: [], open: [], missing: 0 });

  for (const row of rows) {
    const changes = changedHistory(row);
    const first = changes[0];
    const firstAt = instant(first?.enteredAt ?? null);
    if (Number.isFinite(firstAt) && firstAt >= start && firstAt <= end) enteredCount++;

    // The main rework cycle closes at the first real business completion. Later responsibility
    // revisions stay auditable but do not rewrite the original completion period or cycle time.
    const firstCompletion = changes.find(event => event.to === "completed");
    const firstCompletedAt = instant(firstCompletion?.enteredAt ?? null);
    if (Number.isFinite(firstCompletedAt) && firstCompletedAt >= start && firstCompletedAt <= end) {
      completedCount++;
      if (Number.isFinite(firstAt) && firstCompletedAt >= firstAt) cycles.push((firstCompletedAt - firstAt) / 1000);
      else missingCycleCount++;
    }

    // Once the first completion has happened the main cycle is no longer unfinished, even if a
    // later responsibility revision reopens a downstream responsibility node.
    if (!Number.isFinite(firstCompletedAt) || firstCompletedAt > end) {
      const enteredBeforeEnd = changes.filter(event => instant(event.enteredAt) <= end).at(-1);
      if (enteredBeforeEnd && enteredBeforeEnd.to !== "completed") {
        openAtEndCount++;
        const enteredAt = instant(enteredBeforeEnd.enteredAt);
        if (Number.isFinite(enteredAt) && enteredAt <= end) {
          const seconds = Math.max(0, (end - enteredAt) / 1000);
          if (longestOpenSeconds === null || seconds > longestOpenSeconds) {
            longestOpenSeconds = seconds;
            longestOpenItemId = row.id;
          }
          const bucket = nodeValues.get(enteredBeforeEnd.to ?? "");
          if (bucket) bucket.open.push({ seconds, id: row.id });
        }
      }
    }

    for (const event of changes) {
      const node = event.to ?? "", bucket = nodeValues.get(node);
      if (!bucket || event.leftAt === null) continue;
      const enteredAt = instant(event.enteredAt), leftAt = instant(event.leftAt);
      if (!Number.isFinite(leftAt) || leftAt < start || leftAt > end) continue;
      // Main-cycle node statistics stop at first completion; post-completion revisions are a
      // separate diagnostic and must not make the original flow appear slower.
      if (Number.isFinite(firstCompletedAt) && enteredAt > firstCompletedAt) continue;
      if (Number.isFinite(enteredAt) && leftAt >= enteredAt) bucket.completed.push((leftAt - enteredAt) / 1000);
      else bucket.missing++;
    }
  }

  const nodes = NODE_ORDER.map(node => {
    const bucket = nodeValues.get(node)!;
    const longest = [...bucket.open].sort((a, b) => b.seconds - a.seconds || a.id.localeCompare(b.id))[0];
    return {
      node,
      completedCount: bucket.completed.length,
      averageSeconds: average(bucket.completed),
      openAtEndCount: bucket.open.length,
      longestOpenSeconds: longest?.seconds ?? null,
      longestOpenItemId: longest?.id ?? null,
      missingDurationCount: bucket.missing,
    };
  }).filter(node => node.completedCount > 0 || node.openAtEndCount > 0 || node.missingDurationCount > 0);

  return {
    from: filters.from,
    to: filters.to,
    enteredCount,
    completedCount,
    openAtEndCount,
    averageCycleSeconds: average(cycles),
    cycleSampleCount: cycles.length,
    missingCycleCount,
    longestOpenSeconds,
    longestOpenItemId,
    nodes,
  };
}

export function workflowAnalysisResult(rows: Item[], filters: WorkflowAnalysisQuery, asOf: string): WorkflowAnalysisResponse {
  const baseMatches = rows.filter(row => {
    const waiting = !closed(row) && !row.independentFinance;
    return filters.group === "all" || (filters.group === "finance" ? row.independentFinance : filters.group === "waiting" ? waiting : filters.group === "closed" ? closed(row) : row.kind === filters.group);
  });
  const period = periodSummary(baseMatches, filters);
  const matches = baseMatches.filter(row => {
    const waiting = !closed(row) && !row.independentFinance;
    return (!filters.node || row.status === filters.node)
      && (filters.state === "all" || (filters.state === "waiting" ? waiting : closed(row)))
      && (filters.roundtrip === "all" || (filters.roundtrip === "yes" ? row.roundtripCount > 0 : filters.roundtrip === "repeated" ? row.roundtripCount >= 2 : row.roundtripCount === 0))
      && (filters.issue !== "missing" || row.enteredAt === null || row.history.length === 0);
  }).sort((a, b) => {
    if (a.enteredAt === null || b.enteredAt === null) return a.enteredAt === b.enteredAt ? a.id.localeCompare(b.id) : a.enteredAt === null ? 1 : -1;
    return (filters.sort === "longest" ? 1 : -1) * a.enteredAt.localeCompare(b.enteredAt) || a.id.localeCompare(b.id);
  });
  const groups = new Map<string, { key: string; count: number; missingEntryCount: number }>();
  for (const row of matches) {
    const key = `${row.kind}:${row.status}`;
    const group = groups.get(key) ?? { key, count: 0, missingEntryCount: 0 };
    group.count++; if (row.enteredAt === null || row.history.length === 0) group.missingEntryCount++;
    groups.set(key, group);
  }
  const waiting = matches.filter(row => !closed(row) && !row.independentFinance);
  return WorkflowAnalysisResponseSchema.parse({ asOf, filters, total: matches.length,
    waitingCount: waiting.length, roundtripCount: matches.filter(row => row.roundtripCount > 0).length,
    repeatedCount: matches.filter(row => row.roundtripCount >= 2).length,
    longestEnteredAt: waiting.flatMap(row => row.enteredAt ? [row.enteredAt] : []).sort()[0] ?? null,
    missingEntryCount: matches.filter(row => row.enteredAt === null || row.history.length === 0).length,
    periodSummary: period,
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    items: matches.slice((filters.page - 1) * 15, filters.page * 15),
  });
}
