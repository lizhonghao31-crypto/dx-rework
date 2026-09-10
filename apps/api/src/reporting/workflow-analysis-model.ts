import { WorkflowAnalysisResponseSchema, type WorkflowAnalysisQuery, type WorkflowAnalysisResponse } from "@dx-rework/contracts";

type Item = WorkflowAnalysisResponse["items"][number];
const closed = (row: Pick<Item, "status">) => ["completed", "closed", "cancelled"].includes(row.status);
export function workflowAnalysisResult(rows: Item[], filters: WorkflowAnalysisQuery, asOf: string): WorkflowAnalysisResponse {
  const matches = rows.filter(row => {
    const waiting = !closed(row) && !row.independentFinance;
    return (filters.group === "all" || (filters.group === "finance" ? row.independentFinance : filters.group === "waiting" ? waiting : filters.group === "closed" ? closed(row) : row.kind === filters.group))
      && (!filters.node || row.status === filters.node)
      && (filters.state === "all" || (filters.state === "waiting" ? waiting : closed(row)))
      && (filters.roundtrip === "all" || (filters.roundtrip === "yes" ? row.roundtripCount > 0 : filters.roundtrip === "repeated" ? row.roundtripCount >= 2 : row.roundtripCount === 0))
      && (filters.issue !== "missing" || row.enteredAt === null || row.history.length === 0);
  }).sort((a, b) => {
    // Missing timestamps stay separate at the end in both sort directions.
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
    groups: [...groups.values()].sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    items: matches.slice((filters.page - 1) * 15, filters.page * 15),
  });
}
