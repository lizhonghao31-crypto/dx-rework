import { describe, expect, it } from 'vitest';
import { WorkflowAnalysisQuerySchema, WorkflowAnalysisResponseSchema } from '@dx-rework/contracts';
import { workflowAnalysisResult } from '../../apps/api/src/reporting/workflow-analysis-model.js';
const now = '2026-09-10T00:00:00.000Z';
const uid = (id: number) => `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`;
function item(id: number, patch: Record<string, unknown> = {}) {
  return WorkflowAnalysisResponseSchema.shape.items.element.parse({id: uid(id), kind: 'rework', label: `RW-${id}`, status: 'in_progress', independentFinance: false, enteredAt: '2026-09-01T00:00:00.000Z', history: [{id: `event-${id}`, from: 'pending_task_assignment', to: 'in_progress', action: 'rework.task.assign', changesNode: true, enteredAt: '2026-09-01T00:00:00.000Z', leftAt: null}], ...patch});
}
describe('workflow action filters', () => {
  it('counts the complete filtered set before pagination', () => {
    const rows = Array.from({length: 18}, (_, i) => item(i, {roundtripCount: 2}));
    rows.push(item(20, {status: 'completed'}));
    const result = workflowAnalysisResult(rows, WorkflowAnalysisQuerySchema.parse({group: 'rework', state: 'waiting', roundtrip: 'repeated', page: 2}), now);
    expect(result.total).toBe(18); expect(result.waitingCount).toBe(18); expect(result.repeatedCount).toBe(18);
    expect(result.items).toHaveLength(3); expect(result.groups[0]?.count).toBe(18);
  });
  it('keeps missing timestamps last and exposes missing history without fabricating duration', () => {
    const rows = [item(1, {enteredAt: null, history: []}), item(2), item(3, {enteredAt: '2026-09-09T00:00:00.000Z'})];
    const result = workflowAnalysisResult(rows, WorkflowAnalysisQuerySchema.parse({sort: 'shortest'}), now);
    expect(result.items.map(row => row.id)).toEqual([uid(3), uid(2), uid(1)]);
    expect(result.missingEntryCount).toBe(1); expect(result.longestEnteredAt).toBe('2026-09-01T00:00:00.000Z');
    const missing = workflowAnalysisResult(rows, WorkflowAnalysisQuerySchema.parse({issue: 'missing'}), now);
    expect(missing.items.map(row => row.id)).toEqual([uid(1)]); expect(missing.longestEnteredAt).toBeNull();
  });
});
