import {describe,it,expect} from 'vitest';
import {currentProductionStatistics,materialStatistics,windowStatistics} from '../../packages/domain/src/production-statistics.js';
import {productionResultProjection} from '../../apps/api/src/production-platform/production-statistics-projection.js';
import type {StatisticsMaterialRequirement,StatisticsPo,StatisticsProblem,StatisticsTime,StatisticsWindow} from '@dx-rework/contracts/production-statistics';
const observed='2026-11-05T04:00:00Z',day='2026-11-05';
const time=(at:string|null):StatisticsTime=>({at,date:null,precision:at?'instant':'unknown',sourceRefs:at?['TEST original event']:[]});
const po=(change:Partial<StatisticsPo>={}):StatisticsPo=>({orderId:'m1',lineId:'p1',poNumber:'TEST-PO-1',color:'TEST白',customerCode:'TEST客户',productGroup:'针织',sourceId:'s1',salesYear:2026,salesSeries:'P01',primaryMerchandiserId:'u1',designerId:'d1',secondaryMerchandiserIds:[],customerDate:'2026-11-11',quantityVersion:'q1',demand:100,received:0,packing:0,packingRevision:null,quantitySourceRefs:['TEST effective PO/current receiving/packing query'],quality:[],allocations:[],allocationComplete:true,attributions:[],lifecycle:'active',specialClosure:false,problems:[],windows:[],materials:[],...change});
const allocation=(factoryId:string,quantity:number,current=true)=>({scopeId:'scope-'+factoryId,factoryId,factoryName:'TEST厂'+factoryId,quantity,current,version:'v1',sourceRefs:['TEST approved native execution line']});
const calculate=(rows:StatisticsPo[])=>currentProductionStatistics(rows,observed,day);
describe('M01 current production quantity, scope and verified time contracts',()=>{
 it('P08-01 keeps one stable mother/PO and100 demand across repeated source/task joins and two factories',()=>{
  const line=po({allocations:[allocation('a',60),allocation('b',40)]}),r=calculate([line,structuredClone(line),line]);
  expect([r.metrics.orders.value,r.metrics.pos.value,r.metrics.demand.value,r.metrics.unallocated.value]).toEqual([1,1,100,0]);expect(r.factories.map(f=>[f.allocated,f.involvedPoDemand,f.nonAdditiveEntityCounts])).toEqual([[60,100,true],[40,100,true]]);
 });
 it('P08-02 calculates remaining and excess perPO before aggregation',()=>{const r=calculate([po({packing:110}),po({lineId:'p2',orderId:'m2',packing:50})]);expect([r.metrics.remaining.value,r.metrics.excess.value]).toEqual([50,10]);});
 it('P08-03 keeps one global F unknown pool permetric without splitting two pieces into either factory debt',()=>{
  const r=calculate([po({demand:4,received:2,packing:2,quality:[{scopeId:'receipt1',quantityVersion:'r1',quantity:2,qualified:2,inspected:true,sourceRefs:['TEST warehouse inspection']}],allocations:[allocation('a',2),allocation('b',2)]})]);
  expect(['received','qualified','packed','remaining'].map(key=>r.metrics[key as keyof typeof r.metrics].value)).toEqual([2,2,2,2]);expect(r.unattributed.map(pool=>[pool.kind,pool.quantity])).toEqual([['received',2],['qualified',2],['packed',2]]);
  for(const factory of r.factories){expect(factory.actual).toEqual({received:null,qualified:null,packed:null});expect(factory.knownAttributed.received).toBe(0);expect(factory.remaining).toBeNull();expect(factory.attributionUnknown.some(row=>row.key==='factory-remaining')).toBe(true);}
 });
 it('P08-04 preserves effective cumulative2, receipt/QC1 and packing2 without inventing full quality from closure',()=>{
  const white=po({demand:2,received:2,packing:2,specialClosure:true,quality:[{scopeId:'r1',quantityVersion:'receipt-v1',quantity:1,qualified:1,inspected:true,sourceRefs:['TEST actual receipt inspection']}]});
  const r=calculate([white,po({lineId:'black',color:'TEST黑',demand:1,received:1,packing:1,specialClosure:true})]);expect([r.metrics.received.value,r.metrics.packed.value,r.metrics.remaining.value]).toEqual([3,3,0]);expect([r.rows[0]!.qualityCovered,r.rows[0]!.qualityMissing,r.rows[0]!.quantityComplete,r.rows[0]!.qualityComplete]).toEqual([1,1,true,false]);expect(r.metrics.completedOrders.value).toBe(0);expect(r.metrics.specialClosureOrders.value).toBe(1);
 });
 it('P08-05 distinguishes complete empty zero, quantity unknown and conflicting duplicates without last-row wins',()=>{
  expect(calculate([]).metrics.demand.value).toBe(0);const unknown=calculate([po({received:null})]);expect(unknown.metrics.received.value).toBeNull();expect(unknown.metrics.received.unknown[0]!.reason).toContain('累计收货');expect(unknown.metrics.qualified.unknown.length).toBeGreaterThan(0);
  const conflict=calculate([po(),po({demand:101,quantityVersion:'q2'})]);expect(conflict.metrics.demand.value).toBeNull();expect(conflict.metrics.demand.knownValue).toBe(0);
 });
 it('rejects contradictory inspection/allocation versions while retaining independent known global quantities',()=>{
  const row=po({received:2,quality:[{scopeId:'receipt',quantityVersion:'v1',quantity:1,qualified:1,inspected:true,sourceRefs:[]}]});const other=structuredClone(row);other.quality[0]!.quantityVersion='v2';other.quality[0]!.quantity=2;
  const r=calculate([row,other]);expect(r.metrics.received.value).toBe(2);expect(r.metrics.qualityCovered.value).toBeNull();const over=calculate([po({allocations:[allocation('a',60),allocation('b',50)]})]);expect(over.metrics.unallocated.value).toBeNull();expect(over.metrics.unallocated.unknown[0]!.reason).toContain('超配');
 });
 it('P08-08 uses Beijing November5 inclusive to12 exclusive and shows missing commitment separately',()=>{
  const r=calculate([po({lineId:'11',customerDate:'2026-11-11'}),po({lineId:'12',customerDate:'2026-11-12'}),po({lineId:'missing',customerDate:null})]);expect(r.sevenDayWindow).toEqual({fromInclusive:'2026-11-05',toExclusive:'2026-11-12'});expect([r.metrics.nextSevenPos.value,r.metrics.nextSevenQuantity.value,r.metrics.missingCustomerDatePos.value]).toEqual([1,100,1]);
 });
 it('P08-09 keeps zero old allocation in history without reviving current load or dividing PO packing into receipts',()=>{
  const r=calculate([po({demand:1,packing:1,allocations:[allocation('old',0,false),allocation('new',1)]})]);expect(r.metrics.unallocated.value).toBe(0);expect(r.factories.find(f=>f.factoryId==='old')!.historicalOnly).toBe(true);expect(r.factories.find(f=>f.factoryId==='old')!.lineIds).toEqual([]);expect(r.factories.find(f=>f.factoryId==='old')!.actual.received).toBeNull();expect(r.factories.find(f=>f.factoryId==='old')!.excludedReason).toContain('份额为0');expect(r.factories.find(f=>f.factoryId==='new')!.actual.packed).toBeNull();
 });
 it('P08-11 counts whole applicable mother completeness separately from PO, cancellation and special closure',()=>{
  const first=po({demand:1,packing:1}),second=po({lineId:'p2',demand:1});let r=calculate([first,second]);expect([r.metrics.completedPos.value,r.metrics.completedOrders.value]).toEqual([1,0]);r=calculate([first,{...second,packing:1}]);expect([r.metrics.completedPos.value,r.metrics.completedOrders.value]).toEqual([2,1]);r=calculate([po({orderId:'cancelled',lifecycle:'cancelled'}),po({orderId:'special',lineId:'special',specialClosure:true})]);expect([r.metrics.cancelledOrders.value,r.metrics.specialClosureOrders.value,r.metrics.completedOrders.value]).toEqual([1,1,0]);
 });
 it('P08-12 retains60 approved of100, ignores unapproved shares and denominator stays the actual60-piece requirement',()=>{
  const before=calculate([po({allocations:[allocation('a',60)]})]);expect(before.metrics.unallocated.value).toBe(40);expect(before.factories[0]!.allocated).toBe(60);expect(before.factories[0]!.involvedPoDemand).toBe(100);expect(calculate([po({allocations:[allocation('a',60),allocation('b',40)]})]).metrics.unallocated.value).toBe(0);
  const requirement:StatisticsMaterialRequirement={requirementId:'cut60',scopeVersion:'v1',lineId:'p1',factoryId:'a',kind:'裁片',unit:'件',required:60,applicability:'required',eventsComplete:true,events:[{id:'sent30',scopeVersion:'v1',effectiveQuantity:30,time:time('2026-11-01T00:00:00Z'),sourceRefs:[]}],sourceRefs:[]};expect([materialStatistics(requirement).state,materialStatistics(requirement).effectiveQuantity,materialStatistics(requirement).requirement.required]).toEqual(['partial',30,60]);
 });
 it('P08-13 preserves first/latest/full business dates, current version and known quantity despite unknown event time',()=>{
  const requirement:StatisticsMaterialRequirement={requirementId:'r1',scopeVersion:'v1',lineId:'p1',factoryId:'a',kind:'裁片',unit:'件',required:100,applicability:'required',eventsComplete:true,events:[30,50,20].map((quantity,i)=>({id:'e'+i,scopeVersion:'v1',effectiveQuantity:quantity,time:time(`2026-11-0${i+1}T00:00:00Z`),sourceRefs:[]})),sourceRefs:[]};
  expect([1,2,3].map(n=>materialStatistics({...requirement,events:requirement.events.slice(0,n)}).state)).toEqual(['partial','partial','complete']);const r=materialStatistics(requirement);expect([r.first.at,r.latest.at,r.covered.at]).toEqual(['2026-11-01T00:00:00Z','2026-11-03T00:00:00Z','2026-11-03T00:00:00Z']);
  const undated=materialStatistics({...requirement,events:requirement.events.map(e=>({...e,time:time(null)}))});expect([undated.state,undated.effectiveQuantity,undated.covered.at]).toEqual(['complete',100,null]);expect(undated.unknown.length).toBeGreaterThan(0);expect(materialStatistics({...requirement,scopeVersion:'v2'}).state).toBe('not-sent');expect(materialStatistics({...requirement,applicability:'not-applicable'}).state).toBe('not-applicable');expect(materialStatistics({...requirement,applicability:'unknown'}).state).toBe('unknown');
 });
 it('P08-14 separates10h completed from12h unfinished and unions waits2–4/3–5 into3h',()=>{
  const w:StatisticsWindow={id:'w1',orderId:'m1',lineIds:['p1'],nodeKey:'TEST_node',label:'TEST节点',version:'v1',state:'completed',assigneeId:'u1',independent:true,excludedReason:null,entered:time('2026-11-05T00:00:00Z'),completed:time('2026-11-05T10:00:00Z'),deadline:'2026-11-05T11:00:00Z',deadlineExclusive:false,waits:[{id:'w1',from:'2026-11-05T02:00:00Z',to:'2026-11-05T04:00:00Z',verified:true},{id:'w2',from:'2026-11-05T03:00:00Z',to:'2026-11-05T05:00:00Z',verified:true}],waitingCoverage:'partial',sourceRefs:['TEST window/event']};
  const now='2026-11-05T12:00:00Z',complete=windowStatistics(w,now),unfinished=windowStatistics({...w,state:'active',completed:time(null)},now);expect([complete.completedSeconds,complete.unfinishedAgeSeconds,complete.knownWaitingSeconds,complete.waitingCoverage,complete.onTime]).toEqual([36000,null,10800,'partial',true]);expect([unfinished.completedSeconds,unfinished.unfinishedAgeSeconds,unfinished.onTime]).toEqual([null,43200,false]);expect(windowStatistics({...w,independent:false},now).due).toBeNull();
 });
 it('P08-15 preserves occurrence/discovery/registration/explicit resolution and recurrence without inferring from scans or text',()=>{
  const problem:StatisticsProblem={id:'problem1',orderId:'m1',lineIds:['p1'],kind:'TEST independent issue',blocking:true,reasonCode:null,description:'TEST free text is not a standard cause',state:'resolved',occurred:time('2026-11-01T00:00:00Z'),observed:time('2026-11-01T01:00:00Z'),recorded:time('2026-11-02T00:00:00Z'),resolved:time('2026-11-03T00:00:00Z'),recurrenceOf:null,sourceRefs:['TEST explicit problem evidence']};
  const recurring={...problem,id:'problem2',state:'current' as const,recurrenceOf:'problem1',occurred:time(null),observed:time('2026-11-04T01:00:00Z'),resolved:time(null)},r=calculate([po({problems:[problem,recurring,recurring]})]);expect(r.problems).toHaveLength(2);expect(r.problems[1]!.occurred.at).toBeNull();expect(r.problems[1]!.reasonCode).toBeNull();expect(r.metrics.blockedPos.value).toBe(1);expect(calculate([po()]).problems).toEqual([]);expect(problem.state).toBe('resolved');
 });
 it('retains known material quantity and credible first/latest when its numeric denominator is missing, without certifying a changed-scope coverage time',()=>{
  const requirement:StatisticsMaterialRequirement={requirementId:'missing-denominator',scopeVersion:'v1',lineId:'p1',factoryId:'a',kind:'辅料',unit:'米',required:null,applicability:'unknown',eventsComplete:true,events:[{id:'issue1',scopeVersion:'v1',effectiveQuantity:30,time:time('2026-11-01T00:00:00Z'),sourceRefs:['TEST immutable issue']}],sourceRefs:[]};
  const unknown=materialStatistics(requirement);expect([unknown.state,unknown.effectiveQuantity,unknown.first.at]).toEqual(['unknown',30,'2026-11-01T00:00:00Z']);
  const changed=materialStatistics({...requirement,applicability:'required',required:30,historyMatchesScope:false});expect([changed.state,changed.covered.at]).toEqual(['complete',null]);expect(changed.unknown.some(reason=>reason.includes('份额曾变化'))).toBe(true);
  const incomplete=materialStatistics({...requirement,eventsComplete:false});expect([incomplete.effectiveQuantity,incomplete.knownEffectiveQuantity,incomplete.first.at]).toEqual([null,30,null]);
  const unverified=materialStatistics({...requirement,events:requirement.events.map(event=>({...event,time:{...event.time,quality:'unverified' as const}}))});expect(unverified.effectiveQuantity).toBe(30);expect(unverified.first.at).toBeNull();expect(unverified.requirement.events[0]!.time.at).toBe('2026-11-01T00:00:00Z');
 });
 it('does not report finished demand as uncovered production or guess overlap of partially packed and partially allocated ranges',()=>{
  expect(calculate([po({packing:100})]).metrics.unallocated.value).toBe(0);expect(calculate([po({packing:40})]).metrics.unallocated.value).toBe(60);
  const partial=calculate([po({packing:40,allocations:[allocation('a',60)]})]);expect(partial.metrics.unallocated.value).toBeNull();expect(partial.metrics.unallocated.unknown[0]!.reason).toContain('重叠');expect(partial.factories[0]!.allocated).toBe(60);
 });
 it('keeps contradictory problem lifecycle unknown without mutating either observation or hiding independent demand',()=>{
  const problem:StatisticsProblem={id:'same-problem',orderId:'m1',lineIds:['p1'],kind:'TEST conflict',blocking:true,reasonCode:null,description:'TEST same evidence ID conflict',state:'current',occurred:time(null),observed:time(null),recorded:time(null),resolved:time(null),recurrenceOf:null,sourceRefs:[]};
  const first=po({problems:[problem]}),second=po({lineId:'p2',problems:[{...problem,state:'resolved'}]}),result=calculate([first,second]);expect(result.metrics.demand.value).toBe(200);expect(result.metrics.currentProblems.value).toBeNull();expect(result.metrics.blockedPos.value).toBeNull();expect(result.metrics.blockedOrders.value).toBeNull();expect(result.problems[0]!.state).toBe('unknown');expect(problem.state).toBe('current');
 });

 it('marks contradictory explicit attributed totals unknown instead of hiding them behind the global remainder',()=>{
  const row=po({received:2,allocations:[allocation('a',100)],attributions:[{scopeId:'r1',quantityVersion:'v1',current:true,factoryId:'a',quantity:1,kind:'received',sourceRefs:[]},{scopeId:'r2',quantityVersion:'v1',current:true,factoryId:null,quantity:2,kind:'received',sourceRefs:[]}]});const result=calculate([row]);expect(result.metrics.received.value).toBe(2);expect(result.unattributed.find(pool=>pool.kind==='received')!.quantity).toBeNull();expect(result.factories[0]!.actual.received).toBeNull();
 });

 it('does not certify a future completion or a contradictory wait interval as a known result',()=>{
  const window:StatisticsWindow={id:'bad-window',orderId:'m1',lineIds:['p1'],nodeKey:'node',label:'TEST deadline',version:'1',state:'completed',assigneeId:'u1',independent:true,excludedReason:null,entered:time('2026-11-05T00:00:00Z'),completed:time('2026-11-05T13:00:00Z'),deadline:'2026-11-05T11:00:00Z',deadlineExclusive:false,waits:[{id:'ambiguous',from:'2026-11-05T01:00:00Z',to:'2026-11-05T02:00:00Z',verified:true},{id:'ambiguous',from:'2026-11-05T01:00:00Z',to:'2026-11-05T04:00:00Z',verified:true}],waitingCoverage:'complete',sourceRefs:['TEST inconsistent original observations']};
  const result=windowStatistics(window,'2026-11-05T12:00:00Z');expect(result.onTime).toBeNull();expect(result.completedSeconds).toBeNull();expect(result.knownWaitingSeconds).toBe(0);expect(result.waitingCoverage).toBe('partial');
 });
 it('requires the stated current business date to match the actual Beijing observation date',()=>{expect(()=>currentProductionStatistics([], '2026-11-05T16:01:00Z','2026-11-05')).toThrow();});

 it('recalculates a saved factory backlog slice from its original PO facts without mixing another factory or changing the source',()=>{
  const inputs=[po({packing:40,allocations:[allocation('a',60),allocation('b',40)]}),po({lineId:'done',packing:100,allocations:[allocation('a',100)]}),po({lineId:'other',orderId:'m2',allocations:[allocation('b',100)]})],source=calculate(inputs),before=structuredClone(source),filters={from:day,to:day,customer:'',category:'',page:1,view:'production' as const,drillFactoryId:'a',drillMetric:'backlog' as const},slice=productionResultProjection(source,filters,inputs);
  expect(slice.rows.map(row=>row.line.lineId)).toEqual(['p1']);expect([slice.metrics.demand.value,slice.metrics.remaining.value,slice.factories[0]!.allocated]).toEqual([100,60,60]);expect(slice.factories.map(factory=>factory.factoryId)).toEqual(['a']);expect(slice.asOf).toBe(source.asOf);expect(source).toEqual(before);
 });
 it('keeps a specially closed I quality gap reachable independently from the current production backlog',()=>{
  const inputs=[po({demand:2,received:2,packing:2,specialClosure:true,quality:[{scopeId:'receipt',quantityVersion:'v1',quantity:1,qualified:1,inspected:true,sourceRefs:['TEST original warehouse inspection']} ]})],source=calculate(inputs),filters={from:day,to:day,customer:'',category:'',page:1,view:'production' as const};
  expect(productionResultProjection(source,{...filters,drillMetric:'backlog'},inputs).rows).toHaveLength(0);const quality=productionResultProjection(source,{...filters,drillMetric:'quality-gap'},inputs);expect(quality.rows).toHaveLength(1);expect(quality.metrics.qualityMissing.value).toBe(1);expect(quality.metrics.specialClosureOrders.value).toBe(1);
 });
 it('does not erase contradictory receipt versions when slicing a retained result down to its one PO',()=>{
  const first=po({received:2,quality:[{scopeId:'r1',quantityVersion:'v1',quantity:1,qualified:1,inspected:true,sourceRefs:['TEST original receipt']}]}),second=structuredClone(first);second.quality[0]!.quantityVersion='v2';second.quality[0]!.quantity=2;const inputs=[first,second],source=calculate(inputs),slice=productionResultProjection(source,{from:day,to:day,customer:'',category:'',page:1,view:'production',drillLineId:'p1'},inputs);
  expect(source.metrics.qualityCovered.value).toBeNull();expect(slice.metrics.qualityCovered.value).toBeNull();expect(slice.rows[0]!.qualityCovered).toBeNull();expect(slice.metrics.received.value).toBe(2);
 });
 it('keeps a problem without explicit resolution unknown and separates a cancelled order from current problem counts',()=>{
  const problem:StatisticsProblem={id:'unknown-resolution',orderId:'m1',lineIds:['p1'],kind:'TEST original block',blocking:true,reasonCode:null,description:'TEST ended task is not proof of resolution',state:'unknown',occurred:time(null),observed:time(null),recorded:time(null),resolved:time(null),recurrenceOf:null,sourceRefs:['TEST original task ended without explicit unblock']},result=calculate([po({problems:[problem]})]);expect(result.metrics.currentProblems.value).toBeNull();expect(result.metrics.blockedOrders.value).toBeNull();expect(result.metrics.blockedPos.value).toBeNull();expect(result.unknown.some(reason=>reason.key==='problem-lifecycle')).toBe(true);
  const cancelled=calculate([po({lifecycle:'cancelled',problems:[problem]})]);expect(cancelled.metrics.currentProblems.value).toBe(0);expect(cancelled.metrics.currentProblems.excludedIds).toContain(problem.id);expect(cancelled.problems[0]!.state).toBe('unknown');
 });
 it('keeps cancelled exclusions in each metric own entity grain rather than putting two PO IDs into mother or problem collections',()=>{
  const result=calculate([po({lifecycle:'cancelled'}),po({lineId:'p2',lifecycle:'cancelled'})]);expect(result.metrics.completedOrders.excludedIds).toEqual(['m1']);expect(result.metrics.blockedOrders.excludedIds).toEqual(['m1']);expect(result.metrics.remaining.excludedIds).toEqual(['p1','p2']);expect(result.metrics.currentProblems.excludedIds).toEqual([]);
 });
 it('does not call an incomplete original approval or execution mapping an exact uncovered40 while independent demand remains100',()=>{
  const result=calculate([po({allocations:[allocation('a',60)],allocationComplete:false})]);expect(result.metrics.demand.value).toBe(100);expect(result.metrics.unallocated.value).toBeNull();expect(result.metrics.unallocated.unknown[0]!.reason).toContain('集合未完整读取');
 });

});
