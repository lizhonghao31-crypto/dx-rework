import {describe,it,expect} from 'vitest';
import {digitalSlaDefaults} from '@dx-rework/contracts/digital-sla';
import {DEVELOPMENT_CYCLE_DEFAULTS} from '@dx-rework/contracts/digital-development-technical';
import {SERIES_MILESTONE_OFFSETS,SeriesMilestoneOffsetsSchema} from '@dx-rework/contracts/digital-series-plan';
import {orderTimeConfigurationFromLegacy,prepareTimeFrameworkConfiguration,OrderTimeConfigurationSchema} from '@dx-rework/contracts/order-time-settings';
import {FrozenOrderTimePlanSchema} from '@dx-rework/contracts/order-time-plan';
import {fixedDevelopmentWork} from '../../apps/api/src/production-platform/fixed-development-work.js';
import type {FixedWorkInputs} from '../../apps/api/src/production-platform/fixed-work-definition.js';
import {fixedTimelineForward} from '../../apps/api/src/production-platform/fixed-timeline-targets.js';
import {orderTimeSettingsCalculation} from '../../apps/api/src/production-platform/order-time-settings-calculation.js';

const legacy=()=>orderTimeConfigurationFromLegacy({unified:digitalSlaDefaults(),development:DEVELOPMENT_CYCLE_DEFAULTS,planning:{}});
function inputs(framework=true):FixedWorkInputs{
 const values=framework?prepareTimeFrameworkConfiguration(legacy()):legacy();
 return {data:{unified:{configurationId:'TEST original',snapshotRef:'TEST original',values:{ruleVersion:'20261023.1',parameters:{}}},planning:null,development:null,
  orderTimePlan:FrozenOrderTimePlanSchema.parse({version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST original',revision:1,...values}})}};
}
describe('explicit three-layer company standard and original development graph',()=>{
 it('introduces approved durations only in an explicit new standard and preserves the old counterpart',()=>{
  const old=legacy(),next=prepareTimeFrameworkConfiguration(old);
  expect(old.nodes.development_confirmation).toMatchObject({kind:'event',minutes:0});
  expect(old.framework).toBeUndefined();
  expect(next.nodes.development_confirmation).toMatchObject({kind:'work',minutes:120});
  expect(next.nodes.development_positioning).toMatchObject({kind:'work',minutes:240});
  expect(next.framework?.milestoneOffsets).toEqual(SERIES_MILESTONE_OFFSETS);
  expect(prepareTimeFrameworkConfiguration(next)).toEqual(next);
 });
 it('keeps both original A/B semantics and rejects a second shipment date or spurious B milestone',()=>{
  const offsets=structuredClone(SERIES_MILESTONE_OFFSETS);
  expect(SeriesMilestoneOffsetsSchema.safeParse({...offsets,B:{...offsets.B,color_confirmation:12}}).success).toBe(false);
  expect(SeriesMilestoneOffsetsSchema.safeParse({...offsets,A:{...offsets.A,planned_shipment:1}}).success).toBe(false);
  expect(SeriesMilestoneOffsetsSchema.safeParse({...offsets,B:{...offsets.B,fabric_receipt:null}}).success).toBe(false);
 });
 it('preserves a positive configured positioning time and rejects zero-event substitution after adoption',()=>{
  const next=prepareTimeFrameworkConfiguration(legacy());
  next.nodes.development_positioning={...next.nodes.development_positioning!,minutes:180};
  expect(prepareTimeFrameworkConfiguration(next).nodes.development_positioning?.minutes).toBe(180);
  expect(OrderTimeConfigurationSchema.safeParse({...next,nodes:{...next.nodes,development_confirmation:legacy().nodes.development_confirmation}}).success).toBe(false);
 });
 it('positions after pattern in parallel with cutting and joins before the first craft, without double counting',()=>{
  const initial=inputs();initial.data.orderTimePlan!.company.stageBufferMinutes=0;
  const result=fixedDevelopmentWork(initial,'TEST source',1,['development_pattern','development_cutting','development_craft_dispatch','development_printing','development_craft_confirmation','development_confirmation'],[{craftKind:'printing',sequence:1,stepId:'TEST step'}],false,'免洗',false);
  const byKey=(key:string)=>result.work.find(row=>row.parameterKey===key)!;
  expect(byKey('development_positioning').dependsOn).toEqual(['development_pattern']);
  expect(byKey('development_cutting').dependsOn).toEqual(['development_pattern']);
  expect(byKey('development_printing').dependsOn).toEqual(['development_cutting','development_positioning']);
  const planned=fixedTimelineForward(result.work,{precision:'instant',value:'2026-11-02T08:00:00+08:00',source:'TEST accepted'});
  // 48h pattern + max(4h cutting,4h positioning) + 96h craft + 2h final confirmation.
  expect(planned.find(row=>row.id==='development_confirmation')?.end.at).toBe('2026-11-08T06:00:00.000Z');
  expect(byKey('development_confirmation')).toMatchObject({minutes:120,responsibilityMinutes:120,accountingRole:'original_work'});
 });
 it('does not add positioning for no-craft work or rewrite legacy final-confirmation windows',()=>{
  const plain=fixedDevelopmentWork(inputs(),'TEST source',1,['development_pattern','development_cutting','development_confirmation'],[],false,'免洗',false);
  expect(plain.work.some(row=>row.parameterKey==='development_positioning')).toBe(false);
  const old=fixedDevelopmentWork(inputs(false),'TEST source',1,['development_pattern','development_confirmation'],[],false,'免洗',false);
  expect(old.work.at(-1)).toMatchObject({minutes:0,responsibilityMinutes:null,accountingRole:'event'});
 });
 it('uses A/B lead times and all nine/eight milestones in the original settings calculator without actual ready events',()=>{
  const values=prepareTimeFrameworkConfiguration(legacy());values.stageBufferMinutes=0;
  values.nodes.factory_production_work={kind:'forecast',minutes:7*1440,calendar:'continuous',reminder:{enabled:false,percent:70}};
  const input={values,startAt:'2026-12-10T08:00:00+08:00',lines:[{id:'TEST PO',customerDate:'2027-03-15'}],development:{enabled:false,craftSteps:[],washing:'免洗' as const,accessories:false},bulk:{craftSteps:[],preshrink:false}};
  const a=orderTimeSettingsCalculation({...input,frameworkRoute:'A'}).lines[0]!;
  const b=orderTimeSettingsCalculation({...input,frameworkRoute:'B'}).lines[0]!;
  expect(a.milestones).toHaveLength(9);expect(b.milestones).toHaveLength(8);
  expect(a.milestones?.find(row=>row.key==='fabric_receipt')).toMatchObject({date:'2027-01-20',planned:{at:'2027-01-20T00:00:00.000Z'},status:'sufficient'});
  expect(b.milestones?.find(row=>row.key==='fabric_receipt')?.planned.at).toBe('2027-01-10T00:00:00.000Z');
  expect(a.milestones?.find(row=>row.key==='client_sample_approval')).toMatchObject({date:'2027-01-30',planned:{at:'2027-01-30T16:00:00.000Z',exclusive:true}});
  expect(b.milestones?.some(row=>row.key==='color_confirmation')).toBe(false);
  expect(a.rows.find(row=>row.parameterKey==='bulk_cutting')?.startAt).not.toBeNull();
  expect(values.framework?.milestoneOffsets).toEqual(SERIES_MILESTONE_OFFSETS);
 });
 it('binds each PO only to its own dispatch and completion while sharing genuine upstream work',()=>{
  const values=prepareTimeFrameworkConfiguration(legacy());values.stageBufferMinutes=0;
  values.nodes.factory_production_work={kind:'forecast',minutes:7*1440,calendar:'continuous',reminder:{enabled:false,percent:70}};
  const base={values,startAt:'2026-12-10T08:00:00+08:00',frameworkRoute:'B' as const,development:{enabled:false,craftSteps:[],washing:'免洗' as const,accessories:false},bulk:{craftSteps:[],preshrink:false}};
  const lines=[{id:'red',customerDate:'2027-03-15'},{id:'blue',customerDate:'2027-03-22'}];
  const together=orderTimeSettingsCalculation({...base,lines}).lines;
  for(const [index,line]of lines.entries()){
   const alone=orderTimeSettingsCalculation({...base,lines:[line]}).lines[0]!;
   expect(together[index]!.milestones).toEqual(alone.milestones);
   expect(together[index]!.expectedEnd).toBe(alone.expectedEnd);
   expect(together[index]!.rows.some(row=>row.id.endsWith(':'+lines[1-index]!.id))).toBe(false);
  }
 });
});

import {orderTimeFactoryCommitments,outstandingFactoryCommitments} from '../../apps/api/src/production-platform/order-time-factory-commitments.js';
import {factoryDeliveryReadings} from '../../apps/api/src/production-platform/factory-delivery-reading.js';

it('does not reschedule first delivery after a partial receipt or borrow another factory receipt',()=>{
 const commitment={lineId:'red',label:'TEST red',date:'2027-03-05',version:1,source:'TEST factory approval'};
 const scope={productionId:'factory-a',factoryDecisionId:'decision-a',lineId:'red',expected:100,targetDate:commitment.date,commitments:[{at:'2027-03-01T00:00:00Z',date:commitment.date,reference:commitment.source,version:1}]};
 const receipt={id:'receipt-a',productionId:scope.productionId,factoryDecisionId:scope.factoryDecisionId,lineId:'red',quantity:30,receivedAt:'2027-03-04T00:00:00Z'};
 const read=(rows:Parameters<typeof factoryDeliveryReadings>[1],scopes=[scope])=>factoryDeliveryReadings(scopes,rows,'2027-03-07T00:00:00Z');
 const partial=read([receipt]);
 expect(partial[0]).toMatchObject({delivered:true,collected:false,remaining:70});
 expect(outstandingFactoryCommitments([commitment],partial)).toEqual([]);
 const unknown=read([{...receipt,receivedAt:null}, {...receipt,id:'receipt-b'}]);
 expect(unknown[0]).toMatchObject({delivered:true,status:'unknown'});
 expect(outstandingFactoryCommitments([commitment],unknown)).toEqual([]);
 expect(outstandingFactoryCommitments([commitment],read([{...receipt,quantity:0}]))).toEqual([commitment]);
 expect(outstandingFactoryCommitments([commitment],read([receipt],[scope,{...scope,productionId:'factory-b',factoryDecisionId:'decision-b'}]))).toEqual([commitment]);
 expect(outstandingFactoryCommitments([commitment],[])).toEqual([commitment]);
});
import type {evaluateTimeFrameworkCandidate} from '../../apps/api/src/production-platform/order-time-framework.js';
import {orderTimeGapText} from '@dx-rework/contracts/order-time-requests';
it('compares factory return, not factory production, without moving either plan or customer date',()=>{
 const candidate={input:{scopeRef:'po:red',work:[{id:'return_logistics:red',parameterKey:'return_logistics'}]},arranged:[{id:'return_logistics:red',end:{at:'2027-03-07T08:00:00.000Z',exclusive:false,reasons:[]}}]} as ReturnType<typeof evaluateTimeFrameworkCandidate>;
 const original=structuredClone(candidate),commitment={lineId:'red',label:'红PO',date:'2027-03-05',version:1,source:'TEST approved factory date'};
 const late=orderTimeFactoryCommitments([commitment],[candidate]);
 expect(late[0]).toMatchObject({status:'insufficient',lateMinutes:40*60,plannedReceipt:'2027-03-07T08:00:00.000Z'});
 expect(orderTimeGapText({lateMinutes:0,factoryCommitments:late})).toContain('最终交期仍可满足');
 expect(orderTimeFactoryCommitments([{...commitment,date:'2027-03-07',version:2}],[candidate])[0]).toMatchObject({status:'sufficient',lateMinutes:0});
 expect(candidate).toEqual(original);
 expect(orderTimeFactoryCommitments([], [candidate])).toEqual([]);
 expect(orderTimeFactoryCommitments([{...commitment,lineId:'blue'}],[candidate])[0]).toMatchObject({status:'unknown',plannedReceipt:null});
 const boundary=structuredClone(candidate);boundary.arranged[0]!.end.at='2027-03-05T16:00:00.000Z';
 expect(orderTimeFactoryCommitments([commitment],[boundary])[0]!.lateMinutes).toBeGreaterThan(0);
});

it('does not require changing an inapplicable urgent cycle to shorten this order normal cycle',()=>{
 const plan=inputs().data.orderTimePlan!;
 const normal={...plan.company.nodes.development_cycle_normal!,minutes:10};
 expect(FrozenOrderTimePlanSchema.safeParse({...plan,overrides:{development_cycle_normal:normal}}).success).toBe(true);
 expect(plan.company.nodes.development_cycle_urgent!.minutes).toBeGreaterThan(10);
 const bad=prepareTimeFrameworkConfiguration(legacy());bad.nodes.development_cycle_normal={...bad.nodes.development_cycle_normal!,minutes:10};
 expect(OrderTimeConfigurationSchema.safeParse(bad).success).toBe(false);
});
it('uses separately configured bulk washing in previews and never borrows development washing days',()=>{
 const values=prepareTimeFrameworkConfiguration(legacy());values.stageBufferMinutes=0;
 values.nodes.factory_production_work={kind:'forecast',minutes:7*1440,calendar:'continuous',reminder:{enabled:false,percent:70}};
 const input={values,frameworkRoute:'B' as const,startAt:'2026-12-10T08:00:00+08:00',lines:[{id:'TEST PO',customerDate:'2027-03-15'}],development:{enabled:false,craftSteps:[],washing:'免洗' as const,accessories:false},bulk:{craftSteps:[],preshrink:false}};
 const baseline=orderTimeSettingsCalculation(input).lines[0]!;
 expect(values.nodes.bulk_return_washing?.minutes).toBeNull();
 expect(()=>orderTimeSettingsCalculation({...input,bulkWashing:{mode:'after_receipt',accounting:'additional'}})).toThrow('请先填写');
 for(const prefix of ['bulk_factory_washing','bulk_return_washing']){
  values.nodes[prefix]={kind:'work',minutes:120,calendar:'continuous',reminder:{enabled:true,percent:70}};
  values.nodes[prefix+'_inspection']={kind:'work',minutes:60,calendar:'continuous',reminder:{enabled:true,percent:70}};
 }
 for(const mode of ['factory','after_receipt'] as const){
  const result=orderTimeSettingsCalculation({...input,bulkWashing:{mode,accounting:'additional'}}).lines[0]!;
  expect(Date.parse(result.expectedEnd!)-Date.parse(baseline.expectedEnd!)).toBe(3*3600000);
  expect(result.rows.some(row=>row.label.includes('洗水'))).toBe(true);
 }
 const included=orderTimeSettingsCalculation({...input,bulkWashing:{mode:'factory',accounting:'included_in_factory'}}).lines[0]!;
 expect(included.expectedEnd).toBe(baseline.expectedEnd);
});
