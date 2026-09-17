import { WorkflowAnalysisResponseSchema, type WorkflowAnalysisQuery, type WorkflowAnalysisResponse } from "@dx-rework/contracts";

type Item = WorkflowAnalysisResponse["items"][number];
type NodeMetric = WorkflowAnalysisResponse["nodeMetrics"][number];
const terminal = new Set(["completed", "closed", "cancelled", "deleted"]);
const closed = (row: Pick<Item, "status">) => terminal.has(row.status);
const milliseconds = (value: string | null | undefined) => value ? Date.parse(value) : Number.NaN;
const shanghaiStart = (day: string) => Date.parse(`${day}T00:00:00+08:00`);

type SummaryOverride = Partial<Pick<WorkflowAnalysisResponse,
  "enteredCount"|"completedInRangeCount"|"openAtEndCount"|"averageCycleSeconds"|"cycleSampleCount"|"nodeMetrics"|"missingEntryCount"
>>;

function buildResult(rows: Item[], filters: WorkflowAnalysisQuery, asOf: string, summary: SummaryOverride = {}): WorkflowAnalysisResponse {
  const matches = rows.filter(row => {
    const waiting = !closed(row) && !row.independentFinance;
    return (filters.group === "all" || (filters.group === "finance" ? row.independentFinance : filters.group === "waiting" ? waiting : filters.group === "closed" ? closed(row) : row.kind === filters.group))
      && (!filters.node || row.status === filters.node)
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
    missingEntryCount: summary.missingEntryCount ?? matches.filter(row => row.enteredAt === null || row.history.length === 0).length,
    enteredCount: summary.enteredCount ?? 0, completedInRangeCount: summary.completedInRangeCount ?? 0,
    openAtEndCount: summary.openAtEndCount ?? waiting.length, averageCycleSeconds: summary.averageCycleSeconds ?? null,
    cycleSampleCount: summary.cycleSampleCount ?? 0, nodeMetrics: summary.nodeMetrics ?? [],
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    items: matches.slice((filters.page - 1) * 15, filters.page * 15),
  });
}

function periodEndResult(rows: Item[], filters: WorkflowAnalysisQuery, asOf: string): WorkflowAnalysisResponse {
  if (!filters.from || !filters.to) return buildResult(rows, filters, asOf);
  const start = shanghaiStart(filters.from), requestedEnd = shanghaiStart(filters.to) + 86400000;
  const cutoff = Math.min(requestedEnd, Date.parse(asOf));
  const enteredCount = rows.filter(row => Number.isFinite(milliseconds(row.createdAt)) && milliseconds(row.createdAt) >= start && milliseconds(row.createdAt) < cutoff).length;
  let completedInRangeCount = 0, cycleSeconds = 0, cycleSampleCount = 0, missingHistoricalCount = 0;
  const node = new Map<string, { flowSeconds: number; flowCount: number; openCount: number; longestOpenSeconds: number | null }>();
  const snapshotRows: Item[] = [];

  for (const row of rows) {
    const createdAt = milliseconds(row.createdAt);
    if (!Number.isFinite(createdAt) || createdAt >= cutoff) continue;
    const orderedHistory = [...row.history].filter(event => event.enteredAt).sort((a,b) => (a.enteredAt ?? "").localeCompare(b.enteredAt ?? "") || a.id.localeCompare(b.id));
    const firstCompletion = orderedHistory.find(event => event.changesNode && event.to === "completed");
    const completionAt = milliseconds(firstCompletion?.enteredAt);
    if (Number.isFinite(completionAt) && completionAt >= start && completionAt < cutoff) {
      completedInRangeCount++;
      const seconds = Math.max(0, (completionAt - createdAt) / 1000);
      cycleSeconds += seconds; cycleSampleCount++;
    }
    const cycleEnd = Number.isFinite(completionAt) ? Math.min(cutoff, completionAt + 1) : cutoff;
    const cycleHistory = orderedHistory.filter(event => milliseconds(event.enteredAt) < cycleEnd);
    for (const event of cycleHistory) {
      if (!event.changesNode || !event.to || terminal.has(event.to) || !event.enteredAt || !event.leftAt) continue;
      const leftAt = milliseconds(event.leftAt), enteredAt = milliseconds(event.enteredAt);
      if (!Number.isFinite(leftAt) || !Number.isFinite(enteredAt) || leftAt < start || leftAt >= cutoff) continue;
      const current = node.get(event.to) ?? { flowSeconds: 0, flowCount: 0, openCount: 0, longestOpenSeconds: null };
      current.flowSeconds += Math.max(0, (leftAt - enteredAt) / 1000); current.flowCount++;
      node.set(event.to, current);
    }
    const effective = [...cycleHistory].reverse().find(event => event.changesNode && event.to);
    if (!effective?.to || !effective.enteredAt) {
      missingHistoricalCount++;
      continue;
    }
    const status = effective.to;
    const enteredAt = effective.enteredAt;
    const historicalRoundtrips = cycleHistory.filter(event => event.returned || /(reject|return)/.test(event.action)).length;
    const truncatedHistory = cycleHistory.map(event => ({...event, leftAt: event.leftAt && milliseconds(event.leftAt) < cutoff ? event.leftAt : null}));
    const snapshot = { ...row, status, enteredAt, handlers: [], execution: [], submitterName: null, roundtripCount: historicalRoundtrips, history: truncatedHistory };
    snapshotRows.push(snapshot);
    if (!terminal.has(status)) {
      const current = node.get(status) ?? { flowSeconds: 0, flowCount: 0, openCount: 0, longestOpenSeconds: null };
      const waitingSeconds = Math.max(0, (cutoff - milliseconds(enteredAt)) / 1000);
      current.openCount++;
      current.longestOpenSeconds = current.longestOpenSeconds === null ? waitingSeconds : Math.max(current.longestOpenSeconds, waitingSeconds);
      node.set(status, current);
    }
  }

  const nodeMetrics: NodeMetric[] = [...node.entries()].map(([status, value]) => ({ status, flowCount: value.flowCount,
    averageFlowSeconds: value.flowCount ? value.flowSeconds / value.flowCount : null,
    openCount: value.openCount, longestOpenSeconds: value.longestOpenSeconds,
  })).sort((a,b) => (b.averageFlowSeconds ?? -1) - (a.averageFlowSeconds ?? -1) || b.openCount - a.openCount || a.status.localeCompare(b.status));
  const openAtEndCount = snapshotRows.filter(row => !closed(row) && !row.independentFinance).length;
  return buildResult(snapshotRows, filters, asOf, { enteredCount, completedInRangeCount, openAtEndCount,
    averageCycleSeconds: cycleSampleCount ? cycleSeconds / cycleSampleCount : null, cycleSampleCount, nodeMetrics,
    missingEntryCount: missingHistoricalCount });
}

export function workflowAnalysisResult(rows: Item[], filters: WorkflowAnalysisQuery, asOf: string): WorkflowAnalysisResponse {
  if (filters.snapshot === "period_end" && filters.group === "rework") return periodEndResult(rows, filters, asOf);
  return buildResult(rows, filters, asOf);
}
