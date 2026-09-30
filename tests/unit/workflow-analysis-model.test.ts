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
  it('reconstructs a historical period end and keeps waiting time separate from completed flow time', () => {
    const rows = [
      item(1,{createdAt:'2026-09-01T01:00:00.000Z',status:'completed',enteredAt:null,history:[
        {id:'1-a',from:null,to:'draft',action:'rework.draft.create',changesNode:true,enteredAt:'2026-09-01T01:00:00.000Z',leftAt:'2026-09-01T02:00:00.000Z'},
        {id:'1-b',from:'draft',to:'pending_ie_review',action:'rework.submit',changesNode:true,enteredAt:'2026-09-01T02:00:00.000Z',leftAt:'2026-09-01T06:00:00.000Z'},
        {id:'1-c',from:'pending_ie_review',to:'completed',action:'rework.complete',changesNode:true,enteredAt:'2026-09-01T06:00:00.000Z',leftAt:null},
      ]}),
      item(2,{createdAt:'2026-09-02T01:00:00.000Z',status:'in_progress',enteredAt:'2026-09-02T02:00:00.000Z',history:[
        {id:'2-a',from:null,to:'draft',action:'rework.draft.create',changesNode:true,enteredAt:'2026-09-02T01:00:00.000Z',leftAt:'2026-09-02T02:00:00.000Z'},
        {id:'2-b',from:'draft',to:'in_progress',action:'rework.task.assign',changesNode:true,enteredAt:'2026-09-02T02:00:00.000Z',leftAt:null},
      ]}),
    ];
    const result=workflowAnalysisResult(rows,WorkflowAnalysisQuerySchema.parse({group:'rework',snapshot:'period_end',from:'2026-09-01',to:'2026-09-03'}),'2026-09-10T00:00:00.000Z');
    expect(result.enteredCount).toBe(2);expect(result.completedInRangeCount).toBe(1);expect(result.openAtEndCount).toBe(1);
    expect(result.averageCycleSeconds).toBe(5*3600);
    expect(result.nodeMetrics.find(metric=>metric.status==='pending_ie_review')?.averageFlowSeconds).toBe(4*3600);
    expect(result.nodeMetrics.find(metric=>metric.status==='in_progress')?.openCount).toBe(1);
    expect(result.items.map(row=>row.id)).toContain(uid(2));
  });
  it('uses status at the cutoff even if the order is cancelled later', () => {
    const row=item(4,{createdAt:'2026-09-01T01:00:00.000Z',status:'cancelled',enteredAt:null,history:[
      {id:'4-a',from:null,to:'draft',action:'rework.draft.create',changesNode:true,enteredAt:'2026-09-01T01:00:00.000Z',leftAt:'2026-09-01T02:00:00.000Z'},
      {id:'4-b',from:'draft',to:'pending_ie_review',action:'rework.submit',changesNode:true,enteredAt:'2026-09-01T02:00:00.000Z',leftAt:'2026-09-06T00:00:00.000Z'},
      {id:'4-c',from:'pending_ie_review',to:'cancelled',action:'rework.cancel',changesNode:true,enteredAt:'2026-09-06T00:00:00.000Z',leftAt:null},
    ]});
    const result=workflowAnalysisResult([row],WorkflowAnalysisQuerySchema.parse({group:'rework',snapshot:'period_end',from:'2026-09-01',to:'2026-09-03'}),now);
    expect(result.enteredCount).toBe(1);expect(result.openAtEndCount).toBe(1);
    expect(result.items[0]?.status).toBe('pending_ie_review');
    expect(result.nodeMetrics.find(metric=>metric.status==='pending_ie_review')?.openCount).toBe(1);
  });
  it('keeps missing historical transitions unknown instead of fabricating a draft backlog', () => {
    const row=item(5,{createdAt:'2026-09-02T01:00:00.000Z',status:'in_progress',enteredAt:null,history:[]});
    const result=workflowAnalysisResult([row],WorkflowAnalysisQuerySchema.parse({group:'rework',snapshot:'period_end',from:'2026-09-01',to:'2026-09-03'}),now);
    expect(result.enteredCount).toBe(1);expect(result.openAtEndCount).toBe(0);expect(result.missingEntryCount).toBe(1);
    expect(result.nodeMetrics).toHaveLength(0);expect(result.items).toHaveLength(0);
  });
});
