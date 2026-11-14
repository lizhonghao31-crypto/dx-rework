import type {ScheduleNodeProgress} from '@dx-rework/contracts';
import { expect, it } from 'vitest';
import { JOURNEY_NODES, type JourneyBusinessDate, type JourneyNode, type OrderJourney } from '@dx-rework/contracts/digital-production-journey';
import { journeyStages } from '../../apps/api/src/production-platform/journey-projection.js';
import { journeyBusinessProgress } from '../../apps/api/src/production-platform/journey-business-progress.js';
import { journeyBusinessDates } from '../../apps/api/src/production-platform/journey-progress-dates.js';
import { journeyVisualProgress, naturalTimeRatio } from '../../apps/api/src/production-platform/journey-visual-progress.js';
import { journeyDisplay } from '../../apps/api/src/production-platform/journey-display.js';

const now = '2026-11-08T00:00:00.000Z', start = '2026-11-07T00:00:00.000Z', end = '2026-11-09T00:00:00.000Z';
const selected = ['order_information', 'development_materials', 'development_pattern', 'bulk_cutting', 'receipts', 'receiving_inspection', 'packing'];
function fixture(keys = selected): OrderJourney {
  const nodes: JourneyNode[] = JOURNEY_NODES.map(definition => ({ ...definition, instanceId: definition.key,
    state: keys.includes(definition.key) ? 'active' : 'not_applicable', current: true, round: 1, occurrence: null,
    owner: null, operator: null, assignmentHistory: [], expectedAt: null, expectedKind: 'unset', expectedPrecision: 'missing',
    actualAt: null, actualQuality: 'missing', enteredAt: keys.includes(definition.key) ? start : null,
    sla: 'not_started', completionResult: null, overdueSeconds: null, risks: [], blockers: [], records: [], inheritedFrom: null,
    countsInProgress: false, unavailableReason: null, progressApplicability: keys.includes(definition.key) ? 'applicable' : 'not_applicable' }));
  return { id: 'TEST-mother', sourceId: 'TEST-source', orderId: 'TEST-mother', designStyleNo: 'TEST-visual', temporaryStyleNo: null,
    customer: 'TEST', category: null, designer: null, styleName: null, merchandisers: [], orderNumbers: [], createdAt: start,
    deliveryDate: null, selectedRound: 1, adoptedRound: 1, sourceVersion: 1, instructionVersion: 1, lines: [], links: [],
    stages: journeyStages(nodes), progress: { development: null, bulk: null }, hitReasons: [] };
}
const nodes = (order: OrderJourney) => order.stages.flatMap(stage => stage.nodes);
const node = (order: OrderJourney, key: string) => nodes(order).find(value => value.key === key)!;
const progress = (order: OrderJourney) => { order.businessProgress = journeyBusinessProgress(order, now); order.businessProgress.dates = journeyBusinessDates(order); return journeyVisualProgress(order, now); };
const date = (at = end): JourneyBusinessDate => ({ at, precision: 'instant', quality: 'recorded', status: 'complete', covered: 1, total: 1, reasons: [] });

it('R3 actual shares weight applicable stages equally before their effective small nodes, retaining independent n/m', () => {
  const order = fixture();
  for (const key of ['order_information', 'development_materials', 'bulk_cutting', 'receipts']) node(order, key).state = 'completed';
  const result = progress(order);
  expect(order.businessProgress).toMatchObject({ applicable: 7, completed: 4, ratio: 4 / 7 });
  expect(result).toMatchObject({ applicableStages: 4, completedStages: 2, unknownStages: 0, actualRatio: (1 + 1 / 2 + 1 + 1 / 3) / 4 });
  expect(result.stages.find(stage => stage.key === 'receiving')?.actualRatio).toBe(1 / 3);
  expect(result.stages.find(stage => stage.key === 'preparation')).toMatchObject({ applicability: 'not_applicable', actualRatio: null });
});

it('R3 all seven applicable stages keep seven shares rather than one flat node count', () => {
  const order = fixture(['order_information', 'development_pattern', 'bulk_pattern', 'bulk_cutting', 'warehouse_dispatch', 'production_reporting', 'packing']);
  for (const key of ['order_information', 'development_pattern', 'bulk_pattern']) node(order, key).state = 'completed';
  expect(progress(order)).toMatchObject({ applicableStages: 7, completedStages: 3, actualRatio: 3 / 7 });
});

it('R3 business closure does not force still-incomplete effective requirements to 100 percent', () => {
  const order = fixture(['development_pattern', 'packing']); node(order, 'packing').state = 'completed';
  order.display = journeyDisplay(order, now);
  expect(order.display.mainState).toBe('completed');
  expect(progress(order).actualRatio).toBe(0.5);
  expect(order.businessProgress).toMatchObject({ applicable: 2, completed: 1 });
});

it('R3 an overdue stage retains its own risk without changing the existing whole-order state', () => {
  const order = fixture(['bulk_cutting']); node(order, 'bulk_cutting').risks = ['overdue'];
  order.display = journeyDisplay(order, now);
  const before = JSON.stringify(order.display), result = progress(order);
  expect(result.stages.find(stage => stage.key === 'cutting')?.risk).toBe('overdue');
  expect(order.display.mainState).toBe('active');
  expect(JSON.stringify(order.display)).toBe(before);
});

it('R3 splitting a PO/batch obligation cannot add shares or hide an unfinished sibling', () => {
  const order = fixture(['process_logistics', 'bulk_qc']);
  const first = node(order, 'process_logistics'); first.state = 'completed';
  const stage = order.stages.find(stage => stage.key === 'post_cutting')!;
  expect(progress(order).actualRatio).toBe(0.5);
  for (let i = 0; i < 9; i++) stage.nodes.push({ ...first, instanceId: `scope-${i}` });
  expect(progress(order).actualRatio).toBe(0.5);
  stage.nodes.at(-1)!.state = 'active';
  expect(progress(order).actualRatio).toBe(0);
});

it('R3 unknown applicability and a missing catalog scope never disappear as not-applicable or complete', () => {
  const order = fixture(); node(order, 'bulk_cutting').current = false;
  expect(progress(order)).toMatchObject({ actualRatio: null, unknownStages: 1 });
  const other = fixture(); node(other, 'packing').state = 'unavailable';
  expect(progress(other).stages.find(stage => stage.key === 'receiving')).toMatchObject({ applicability: 'unknown', actualRatio: null });
  expect(progress(fixture([]))).toMatchObject({ actualRatio: null, applicableStages: 0 });
});

it('R3 source-only development cannot obtain completed shares from bulk stages', () => {
  const order = fixture(); order.orderId = null; node(order, 'development_materials').state = 'completed';
  expect(progress(order)).toMatchObject({ applicableStages: 1, actualRatio: 0.5 });
  expect(progress(order).stages.find(stage => stage.key === 'creation')?.actualRatio).toBeNull();
});

it('R3 inherited completion uses original effective evidence without inventing a current adoption date', () => {
  const order = fixture(['development_pattern']), current = node(order, 'development_pattern');
  current.state = 'inherited'; current.inheritedFrom = { taskId: 'original-result', round: 1 }; current.enteredAt = null;
  order.stages.find(stage => stage.key === 'development')!.nodes.push({ ...current, instanceId: 'original-result', current: false,
    state: 'completed', enteredAt: '2026-10-01T00:00:00.000Z', actualAt: '2026-10-02T00:00:00.000Z', actualQuality: 'verified', inheritedFrom: null });
  const result = progress(order);
  expect(result.actualRatio).toBe(1);
  expect(result.startedAt).toBeNull(); expect(result.actual.at).toBeNull(); expect(result.timeRatio).toBeNull();
});

it('R3 natural elapsed time includes Sunday and remains bounded before, within and after a reliable window', () => {
  expect(naturalTimeRatio(start, date(), '2026-11-06T00:00:00.000Z')).toBe(0);
  expect(naturalTimeRatio(start, date(), now)).toBe(0.5);
  expect(naturalTimeRatio(start, date(), '2026-11-10T00:00:00.000Z')).toBe(1);
  expect(naturalTimeRatio(start, date(start), now)).toBeNull();
  expect(naturalTimeRatio(start, date('2026-11-06T00:00:00.000Z'), now)).toBeNull();
  expect(naturalTimeRatio(start, { ...date(), at: '2026-11-09', precision: 'date' }, now)).toBe(0.375);
  expect(naturalTimeRatio(start, date('2026-11-09T00:00:00'), now)).toBeNull();
});

it('Final10 uses a legitimate date forecast at Beijing day-end, including Sunday, without inventing an event instant', () => {
  const expected: JourneyBusinessDate = { ...date(), at: '2026-11-08', precision: 'date' };
  const before = structuredClone(expected);
  // Saturday 08:00 to Monday 00:00 Beijing is forty natural hours.
  expect(naturalTimeRatio(start, expected, now)).toBe(24 / 40);
  expect(naturalTimeRatio(start, expected, '2026-11-08T15:59:59.999Z')).toBeCloseTo(1 - 1 / (40 * 3600_000));
  expect(naturalTimeRatio(start, expected, '2026-11-08T16:00:00.000Z')).toBe(1);
  expect(expected).toEqual(before);
});

it.each(['2026-02-29', '2026-11-31', '2026-11-08T00:00:00.000Z'])('Final10 keeps an invalid calendar forecast %s unknown', at => {
  expect(naturalTimeRatio(start, { ...date(), at, precision: 'date' }, now)).toBeNull();
});

it('Final10 does not invent a date-only start or promote partial/unknown dates into a reliable window', () => {
  const expected: JourneyBusinessDate = { ...date(), at: '2026-11-08', precision: 'date' };
  expect(naturalTimeRatio('2026-11-07', expected, now)).toBeNull();
  expect(naturalTimeRatio(null, expected, now)).toBeNull();
  expect(naturalTimeRatio(start, { ...expected, status: 'partial' }, now)).toBeNull();
  expect(naturalTimeRatio(start, { ...expected, status: 'unknown' }, now)).toBeNull();
});

it('Final10 list and detail visual projection keep the same date forecast and independent actual progress', () => {
  const order = fixture(['bulk_cutting']); progress(order);
  const expected: JourneyBusinessDate = { ...date(), at: '2026-11-08', precision: 'date', bases: ['standard_window'] };
  order.businessProgress!.dates!.overall.forecast = structuredClone(expected);
  order.businessProgress!.dates!.stages.find(stage => stage.key === 'cutting')!.forecast = structuredClone(expected);
  const before = structuredClone(order), visual = journeyVisualProgress(order, now);
  expect(visual).toMatchObject({ timeRatio: null, actualRatio: 0, expected });
  expect(visual.stages.find(stage => stage.key === 'cutting')).toMatchObject({ timeRatio: 24 / 40, actualRatio: 0, expected });
  expect(order).toEqual(before);
});

it('Final10 completed native milestones without task entry cannot erase a known effective scope start', () => {
  const order=fixture(['order_information','customer_sample','bulk_marker','receipts','rework']);
  const creation=node(order,'order_information');creation.state='completed';creation.enteredAt=null;creation.actualAt=start;creation.actualQuality='verified';
  node(order,'rework').enteredAt=new Date(Date.parse(start)+4*3600_000).toISOString();
  for(const [key,offset]of [['customer_sample',1],['bulk_marker',2],['receipts',3]] as const){
    const value=node(order,key);value.instanceId=`${key}:0`;value.round=null;value.enteredAt=null;value.state='completed';
    value.actualQuality='verified';value.actualAt=new Date(Date.parse(start)+offset*3600_000).toISOString();
    if(key==='receipts'){value.actualDate='2026-11-07';value.actualAt=null;}
  }
  const initial=progress(order),forecast={...date(),covered:5,total:5,bases:['standard_window' as const]};
  order.businessProgress!.dates!.overall.forecast=forecast;
  const result=journeyVisualProgress(order,now);
  expect(result).toMatchObject({startedAt:start,timeRatio:null,actualRatio:initial.actualRatio});
  expect(result.stages.find(stage=>stage.key==='preparation')!.startedAt).toBeNull();
  for(const key of ['customer_sample','bulk_marker','receipts'])expect(node(order,key).enteredAt).toBeNull();
});

it('Final10 a completed milestone alone or a real task missing entry does not invent an execution start', () => {
  const order=fixture(['customer_sample']),value=node(order,'customer_sample');
  value.instanceId='customer_sample:0';value.round=null;value.enteredAt=null;value.state='completed';value.actualQuality='verified';value.actualAt=start;
  progress(order);order.businessProgress!.dates!.overall.forecast={...date(),bases:['actual']};
  expect(journeyVisualProgress(order,now).startedAt).toBeNull();
  const taskOrder=fixture(['bulk_pattern','bulk_marker']),task=node(taskOrder,'bulk_marker');
  task.instanceId='TEST-real-marker-task';task.occurrence=1;task.enteredAt=null;task.state='completed';task.actualQuality='verified';task.actualAt=start;
  progress(taskOrder);taskOrder.businessProgress!.dates!.overall.forecast={...date(),bases:['standard_window']};
  expect(journeyVisualProgress(taskOrder,now).startedAt).toBeNull();
});

it('R3 two visual ratios reuse the same snapshot and existing forecast/actual dates without substituting the plan or deadline', () => {
  const order = fixture(['bulk_cutting']); progress(order);
  const dates = order.businessProgress!.dates!;
  dates.overall.forecast = { ...date(), bases: ['standard_window'] };
  dates.stages.find(stage => stage.key === 'cutting')!.forecast = { ...date(), bases: ['standard_window'] };
  const before = JSON.stringify(order), result = journeyVisualProgress(order, now);
  expect(result).toMatchObject({ timeRatio: null, actualRatio: 0, startedAt: start, expected: { at: end } });
  expect(result.stages.find(stage => stage.key === 'cutting')?.timeRatio).toBe(0.5);
  expect(JSON.stringify(order)).toBe(before);
  dates.overall.forecast = { ...dates.overall.forecast, at: null, status: 'unknown' };
  dates.overall.adoptedPlan = { ...dates.overall.adoptedPlan, ...date() };
  node(order, 'bulk_cutting').expectedAt = end;
  expect(journeyVisualProgress(order, now)).toMatchObject({ timeRatio: null, expected: { at: null } });
  order.businessProgress!.asOf = '2026-11-07T23:59:59.000Z';
  expect(journeyVisualProgress(order, now)).toMatchObject({ actualRatio: null, timeRatio: null });
});

it('R3 missing effective entry times and historical/planning records cannot fabricate a start', () => {
  const order = fixture(['bulk_cutting']), current = node(order, 'bulk_cutting'); progress(order);
  order.businessProgress!.dates!.overall.forecast = { ...date(), bases: ['standard_window'] };
  current.enteredAt = null;
  order.stages.find(stage => stage.key === 'cutting')!.nodes.push({ ...current, instanceId: 'old-round', current: false, enteredAt: start });
  const plan = nodes(order).find(node => node.planningOnly)!; plan.enteredAt = start;
  expect(journeyVisualProgress(order, now)).toMatchObject({ startedAt: null, timeRatio: null });
});

it('supply-chain v2 uses frozen per-scope B and physical delivery A while preserving the old lifecycle and actual progress',()=>{
 const order=fixture(['bulk_cutting']),current=node(order,'bulk_cutting');current.expectedAt='2026-11-10T00:00:00Z';current.expectedKind='plan';current.expectedPrecision='instant';
 const point:ScheduleNodeProgress={id:'bulk_cutting',scopeRef:'po:TEST-A',targetRevision:'TEST frozen1',canonicalWorkRef:'TEST nativecut',state:'normal' as const,lagMinutes:{minimum:0,maximum:0},businessCompleted:false,availabilityBound:null,creditLimit:null,goalDelta:{kind:'on_target' as const,signedValue:0,unit:'minute' as const,asOf:now,targetAt:end,targetPrecision:'instant' as const,targetDate:null,actual:{precision:'unknown' as const},targetRevision:'TEST frozen1',scopeRef:'po:TEST-A'},ownSla:{state:'not_adopted' as const,overdueMinutes:null,sourceRef:null},coverage:[]};
 current.fixedTargets=[{scopeRef:point.scopeRef,lineId:'TEST-A',progress:point}];order.fixedSchedule={version:'fixed-schedule-progress-v1',asOf:now,scopeRevision:'TEST1',factRevision:'TEST1',state:'normal',scopes:[{scopeRef:point.scopeRef,lineId:'TEST-A',targetRevision:'TEST1',state:'normal',lagMinutes:{minimum:0,maximum:0},customerDuePassed:false,nodes:[point],coverage:[]}],durationSummary:{planStart:start,planEnd:end,actualStart:{precision:'unknown'},observationAt:now,deliveryCompletedAt:{precision:'unknown'},planSpanMinutes:2880,elapsedSpanMinutes:null,finalActualSpanMinutes:null,asOf:now,coverage:[]},legacyOverdue:false,nextChangeAt:null};
 order.display=journeyDisplay(order,now);const lifecycle=JSON.stringify(order.display),result=progress(order);
 expect(result.stages.find(stage=>stage.key==='cutting')?.expected).toMatchObject({at:end,precision:'instant',status:'complete'});expect(result.expected.at).toBe(end);expect(result.actual).toMatchObject({at:null,status:'unknown'});expect(result.actualRatio).toBe(0);expect(JSON.stringify(order.display)).toBe(lifecycle);
 point.goalDelta.targetAt=null;expect(progress(order).stages.find(stage=>stage.key==='cutting')?.expected.at).toBeNull();
});


it('PR08 uses the customer commitment for elapsed time and freezes it at known completion or termination',()=>{
 const order=fixture(['bulk_cutting']);progress(order);
 order.lines=[{id:'TEST line',po:'TEST-PO',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}];
 order.poDeliveryDates=[{lineId:'TEST line',customerWarehouseArrivalDate:'2026-11-08'} as NonNullable<OrderJourney['poDeliveryDates']>[number]];
 order.businessProgress!.dates!.overall.forecast={...date('2027-01-01T00:00:00Z'),bases:['standard_window']};
 const live=journeyVisualProgress(order,now);
 expect(live).toMatchObject({delivery:{at:'2026-11-08'},timeRatio:24/40,expected:{at:'2027-01-01T00:00:00Z'}});
 order.businessProgress!.dates!.overall.forecast={...date('2026-11-10T00:00:00Z'),bases:['standard_window']};
 expect(journeyVisualProgress(order,now)).toMatchObject({timeRatio:24/40,actualRatio:live.actualRatio,expected:{at:'2026-11-10T00:00:00Z'}});
 order.poDeliveryDates![0]!.customerWarehouseArrivalDate=null;
 expect(journeyVisualProgress(order,now)).toMatchObject({startedAt:live.startedAt,timeRatio:null,actualRatio:live.actualRatio,delivery:{at:null}});
 order.poDeliveryDates![0]!.customerWarehouseArrivalDate='2026-11-08';
 order.display={stages:[],mainState:'completed',closedAt:'2026-11-07T12:00:00Z'} as OrderJourney['display'];
 expect(journeyVisualProgress(order,now).timeRatio).toBe(12/40);
 order.display!.mainState='closed';expect(journeyVisualProgress(order,now).timeRatio).toBe(12/40);
 order.display!.closedAt=null;expect(journeyVisualProgress(order,now).timeRatio).toBeNull();
});
