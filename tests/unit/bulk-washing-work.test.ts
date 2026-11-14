import {it,expect} from 'vitest';
import type {BulkWashingArrangement} from '../../packages/contracts/src/bulk-washing.js';
import type {FixedTimelineInput} from '../../apps/api/src/production-platform/fixed-timeline-adoptions.js';
import {bulkWashingWork} from '../../apps/api/src/production-platform/bulk-washing-work.js';
import {fixedTimelineForward} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
import {fixedOrderWork} from '../../apps/api/src/production-platform/fixed-order-work.js';
import {digitalSlaDefaults,DIGITAL_SLA_RULE_VERSION} from '@dx-rework/contracts/digital-sla';
import type {FixedWorkInputs} from '../../apps/api/src/production-platform/fixed-work-definition.js';
import {FrozenOrderTimePlanSchema} from '@dx-rework/contracts/order-time-plan';
import {orderTimeInputFromRoute} from '../../apps/api/src/production-platform/order-time-request-plan.js';
import {buildOrderTimeWork} from '../../apps/api/src/production-platform/order-time-schedule.js';
type Work=FixedTimelineInput['work'][number];
const policy={minutes:1440,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
const factory:Work={id:'factory',dependsOn:[],minutes:7200,calendar:'continuous',canonicalWorkRef:'factory',planningParameterRef:'original',responsibilitySlaRef:null};
const plan=(mode:'factory'|'after_receipt',included=false):BulkWashingArrangement=>mode==='factory'
 ?{mode,reference:'bulk-standard',revision:1,accounting:included?'included_in_factory':'additional',washing:policy,inspection:{...policy,minutes:120}}
 :{mode,reference:'bulk-standard',revision:1,accounting:'additional',washing:policy,inspection:{...policy,minutes:120}};
const start={precision:'instant' as const,value:'2026-11-12T00:00:00.000Z',source:'TEST 08:00 Beijing'};
it('decomposes a five-day inclusive factory allocation without charging washing/checking twice',()=>{
 const route=bulkWashingWork('order','red',plan('factory',true),factory,'receipt-qc');
 const result=fixedTimelineForward([route.factory,...route.work],start);
 expect(route.factory.minutes).toBe(5640);
 expect(result.at(-1)?.end.at).toBe('2026-11-17T00:00:00.000Z');
 expect(factory.minutes).toBe(7200);
 expect(route.packingPredecessor).toBe('receipt-qc');
});
it('adds separately approved washing and inspection after non-inclusive factory production',()=>{
 const route=bulkWashingWork('order','red',plan('factory'),factory,'receipt-qc');
 expect(fixedTimelineForward([route.factory,...route.work],start).at(-1)?.end.at).toBe('2026-11-18T02:00:00.000Z');
 expect(route.factoryEnd).toBe('bulk_factory_washing_inspection:red');
});
it('post-receipt washing follows the particular batch eligible inspection without moving first delivery',()=>{
 const route=bulkWashingWork('order','blue',plan('after_receipt'),factory,'receipt-qc');
 const receipt={...factory,id:'receipt-qc',minutes:0};
 expect(route.factoryEnd).toBe('factory');
 expect(route.packingPredecessor).toBe('bulk_return_washing_inspection:blue');
 expect(fixedTimelineForward([receipt,...route.work],start).at(-1)?.end.at).toBe('2026-11-13T02:00:00.000Z');
});
it('does not infer a washing route for old or exempt orders',()=>{
 for(const value of [undefined,{mode:'none'} as const])expect(bulkWashingWork('order','red',value,factory,'receipt-qc'))
  .toEqual({factory,work:[],factoryEnd:'factory',packingPredecessor:'receipt-qc'});
});
it('rejects unsupported inclusion instead of shortening or guessing the factory total',()=>{
 for(const parent of [{...factory,minutes:null},{...factory,minutes:60},{...factory,calendar:'beijing_sunday_excluded' as const}])
  expect(()=>bulkWashingWork('order','red',plan('factory',true),parent,'receipt-qc')).toThrow('内含洗水');
});
it('expands only the selected PO and retains the original packing chain on a sibling',()=>{
 const initial:FixedWorkInputs={data:{unified:{configurationId:'TEST',snapshotRef:'TEST',values:{ruleVersion:DIGITAL_SLA_RULE_VERSION,
  parameters:Object.fromEntries(Object.entries(digitalSlaDefaults()).map(([key,value])=>[key,{value,source:'global',sourceVersion:1}]))}},
  development:null,planning:null}};
 const result=fixedOrderWork(initial,'order','source',1,'无需预缩',[],false,null,[
  {line_id:'red',goal:start,customerDateVersion:1,washing:plan('after_receipt')},
  {line_id:'blue',goal:start,customerDateVersion:1}]);
 expect(result.work.find(w=>w.id==='garment_packing:red')?.dependsOn).toEqual(['bulk_return_washing_inspection:red']);
 expect(result.work.find(w=>w.id==='garment_packing:blue')?.dependsOn).toEqual(['garment_inspection:blue']);
 expect(result.consumers.find(c=>c.lineId==='blue')?.nodeIds.some(id=>id.startsWith('bulk_return_washing'))).toBe(false);
 expect(result.consumers.find(c=>c.lineId==='red')?.nodeIds).toContain('bulk_return_washing:red');
});
it('uses the selected bulk calendar, including a Sunday boundary, without creating actual starts',()=>{
 const selected=plan('after_receipt');if(selected.mode==='none')throw Error('fixture');
 selected.washing={...policy,minutes:120,calendar:'beijing_sunday_excluded'};
 selected.inspection={...policy,minutes:60,calendar:'beijing_sunday_excluded'};
 const route=bulkWashingWork('order','red',selected,factory,'receipt-qc');
 const rows=fixedTimelineForward([{...factory,id:'receipt-qc',minutes:0},...route.work],
  {...start,value:'2026-11-14T15:00:00.000Z'}); // Saturday23:00 Beijing → Monday02:00
 expect(rows.at(-1)?.end.at).toBe('2026-11-15T18:00:00.000Z');
 expect(route.work.every(node=>!('ready' in node)&&!('startedAt' in node))).toBe(true);
});
it('preserves the per-PO washing duration and inclusive factory remainder across the original adoption adapter',()=>{
 const company=FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST company',revision:1,stageBufferMinutes:0,nodes:{
  factory_production_work:{kind:'forecast',...policy,minutes:7200},
 }}});
 const route=bulkWashingWork('order','red',plan('factory',true),{...factory,parameterKey:'factory_production_work',stage:6},'receipt-qc');
 const converted=orderTimeInputFromRoute(company,{work:[route.factory,...route.work],consumers:[{scopeRef:'po:red',lineId:'red',nodeIds:[route.factory.id,...route.work.map(row=>row.id)],ends:{[route.factoryEnd]:start}}]},new Map([['po:red',start]]),true);
 const rebuilt=buildOrderTimeWork(converted.plan,converted.work);
 expect(rebuilt.map(row=>row.minutes)).toEqual([5640,1440,120]);
 expect(fixedTimelineForward(rebuilt,start).at(-1)?.end.at).toBe('2026-11-17T00:00:00.000Z');
 expect(converted.work[1]?.nativeDuration?.reference).toBe('bulk-standard:washing:1:bulk_factory_washing');
 expect(company.company.nodes.factory_production_work?.minutes).toBe(7200);
});
it('does not accept a per-scope washing policy as a substitute for an unrelated node SLA',()=>{
 const company=FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST company',revision:1,stageBufferMinutes:0,nodes:{cut:{kind:'work',...policy}}}});
 expect(()=>buildOrderTimeWork(company,[{id:'cut',parameterKey:'cut',stage:4,dependsOn:[],nativeDuration:{reference:'TEST unrelated',minutes:1,calendar:'continuous'}}])).toThrow('不属于洗水');
});
