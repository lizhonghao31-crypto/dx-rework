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
  it('reconstructs historical period flow without replacing waiting time with work time', () => {
    const completed = item(30, {status: 'completed', enteredAt: null, history: [
      {id:'30-a',from:null,to:'draft',action:'rework.draft.create',changesNode:true,enteredAt:'2026-09-01T00:00:00.000Z',leftAt:'2026-09-01T01:00:00.000Z'},
      {id:'30-b',from:'draft',to:'pending_ie_review',action:'rework.submit',changesNode:true,enteredAt:'2026-09-01T01:00:00.000Z',leftAt:'2026-09-01T05:00:00.000Z'},
      {id:'30-c',from:'pending_ie_review',to:'in_progress',action:'rework.ie.approve',changesNode:true,enteredAt:'2026-09-01T05:00:00.000Z',leftAt:'2026-09-02T05:00:00.000Z'},
      {id:'30-d',from:'in_progress',to:'completed',action:'rework.complete',changesNode:true,enteredAt:'2026-09-02T05:00:00.000Z',leftAt:null},
    ]});
    const stillOpen = item(31, {status:'pending_ie_review', enteredAt:'2026-09-03T00:00:00.000Z', history:[
      {id:'31-a',from:null,to:'draft',action:'rework.draft.create',changesNode:true,enteredAt:'2026-09-03T00:00:00.000Z',leftAt:'2026-09-03T01:00:00.000Z'},
      {id:'31-b',from:'draft',to:'pending_ie_review',action:'rework.submit',changesNode:true,enteredAt:'2026-09-03T01:00:00.000Z',leftAt:null},
    ]});
    const result = workflowAnalysisResult([completed, stillOpen], WorkflowAnalysisQuerySchema.parse({group:'rework',periodMode:'activity',from:'2026-09-01',to:'2026-09-05'}), now);
    expect(result.periodSummary?.enteredCount).toBe(2);
    expect(result.periodSummary?.completedCount).toBe(1);
    expect(result.periodSummary?.openAtEndCount).toBe(1);
    expect(result.periodSummary?.averageCycleSeconds).toBe(29 * 3600);
    const ie = result.periodSummary?.nodes.find(node=>node.node==='pending_ie_review');
    expect(ie?.completedCount).toBe(1);
    expect(ie?.averageSeconds).toBe(4 * 3600);
    expect(ie?.openAtEndCount).toBe(1);
    expect(ie?.longestOpenItemId).toBe(uid(31));
  });
  it('does not reopen the main cycle when responsibility is revised after first completion', () => {
    const revised = item(40, {status:'pending_responsibility_determination', enteredAt:'2026-09-04T00:00:00.000Z', history:[
      {id:'40-a',from:null,to:'draft',action:'rework.draft.create',changesNode:true,enteredAt:'2026-09-01T00:00:00.000Z',leftAt:'2026-09-01T01:00:00.000Z'},
      {id:'40-b',from:'draft',to:'completed',action:'rework.complete',changesNode:true,enteredAt:'2026-09-02T00:00:00.000Z',leftAt:'2026-09-04T00:00:00.000Z'},
      {id:'40-c',from:'completed',to:'pending_responsibility_determination',action:'rework.responsibility.revise',changesNode:true,enteredAt:'2026-09-04T00:00:00.000Z',leftAt:null},
    ]});
    const result = workflowAnalysisResult([revised], WorkflowAnalysisQuerySchema.parse({group:'rework',periodMode:'activity',from:'2026-09-01',to:'2026-09-05'}), now);
    expect(result.periodSummary?.completedCount).toBe(1);
    expect(result.periodSummary?.openAtEndCount).toBe(0);
    expect(result.periodSummary?.nodes.find(node=>node.node==='pending_responsibility_determination')?.openAtEndCount ?? 0).toBe(0);
  });
  it('keeps completed orders with missing start history out of average cycle time', () => {
    const incompleteHistory = item(50, {status:'completed', enteredAt:null, history:[
      {id:'50-a',from:'in_progress',to:'completed',action:'rework.complete',changesNode:true,enteredAt:'2026-09-03T00:00:00.000Z',leftAt:null},
    ]});
    const result = workflowAnalysisResult([incompleteHistory], WorkflowAnalysisQuerySchema.parse({group:'rework',periodMode:'activity',from:'2026-09-01',to:'2026-09-05'}), now);
    expect(result.periodSummary?.completedCount).toBe(1);
    expect(result.periodSummary?.cycleSampleCount).toBe(0);
    expect(result.periodSummary?.missingCycleCount).toBe(1);
    expect(result.periodSummary?.averageCycleSeconds).toBeNull();
  });
});
