import {expect,it} from 'vitest';
import {renderToStaticMarkup} from 'react-dom/server';
import {createElement} from 'react';
import {JOURNEY_NODES,type JourneyNode,type JourneyRequirementTarget,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {SeriesPlanSnapshot} from '@dx-rework/contracts/digital-series-plan';
import {journeyStages} from '../../apps/api/src/production-platform/journey-projection.js';
import {journeyBusinessProgress,journeyBusinessQuantities,type AdoptedRequirementPlan} from '../../apps/api/src/production-platform/journey-business-progress.js';
import {adoptedJourneyTargets} from '../../apps/api/src/production-platform/journey-adopted-plan.js';
import {CockpitBusinessProgress} from '../../apps/web/src/cockpit-business-progress.js';

const asOf='2026-11-05T00:00:00.000Z';
const selected=['order_information','development_materials','development_pattern','bulk_pattern','bulk_cutting','process_logistics','bulk_qc','warehouse_dispatch','packing'];
function fixture():OrderJourney {
  const nodes:JourneyNode[]=JOURNEY_NODES.map(definition=>({...definition,instanceId:definition.key,state:selected.includes(definition.key)?'active':'not_applicable',current:true,round:null,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:false,unavailableReason:null,progressApplicability:selected.includes(definition.key)?'applicable':'not_applicable'}));
  return {id:'mother',sourceId:'source',orderId:'mother',designStyleNo:'TEST-REQUIREMENTS',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:asOf,deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:1,lines:[],links:[],stages:journeyStages(nodes),progress:{development:null,bulk:null},hitReasons:[]};
}
const nodes=(order:OrderJourney)=>order.stages.flatMap(stage=>stage.nodes);
const node=(order:OrderJourney,key:string)=>nodes(order).find(value=>value.key===key)!;
const target=(key:string,revision=1):JourneyRequirementTarget=>({source:'series_plan',planId:`plan-${revision}`,revision,scopeRef:'whole',at:selected.indexOf(key)<4?'2026-11-04':'2026-11-06',precision:'date',retainedFromRevision:null});
function plan(keys=selected,revision=1):AdoptedRequirementPlan{return {planId:`plan-${revision}`,revision,targets:new Map(keys.map(key=>[key,[target(key,revision)]]))};}

it('P01-02/03: splitting a single obligation into two or ten batches never increases its weight; every scope must finish',()=>{
  const order=fixture();node(order,'process_logistics').state='completed';const original=journeyBusinessProgress(order,asOf);
  const stage=order.stages.find(stage=>stage.key==='post_cutting')!;
  for(let i=0;i<9;i++)stage.nodes.push({...node(order,'process_logistics'),instanceId:`batch-${i}`});
  expect(journeyBusinessProgress(order,asOf)).toMatchObject({applicable:9,completed:original.completed,ratio:original.ratio});
  stage.nodes.at(-1)!.state='active';expect(journeyBusinessProgress(order,asOf).completed).toBe(original.completed-1);
});
it('P01-04: a retired execution without a current replacement leaves the requirement unknown',()=>{
  const order=fixture();node(order,'bulk_cutting').current=false;
  const result=journeyBusinessProgress(order,asOf);
  expect(result).toMatchObject({applicable:8,unknown:1,ratio:null});
  expect(result.requirements.find(row=>row.key==='bulk_cutting')?.reasons[0]).toContain('承接记录');
});
it('P01-03: a completed sibling cannot hide the specific PO and factory that still must finish',()=>{
  const order=fixture(),first=node(order,'process_logistics');first.state='completed';first.subject='黑PO · 甲厂';
  order.stages.find(stage=>stage.key==='post_cutting')!.nodes.push({...first,instanceId:'white-factory',subject:'白PO · 乙厂',state:'active'});
  const requirement=journeyBusinessProgress(order,asOf).requirements.find(row=>row.key==='process_logistics')!;
  expect(requirement.completed).toBe(false);expect(requirement.reasons).toContain('尚待白PO · 乙厂完成');
});
it('P01-04: retiring one same-round scope cannot disappear behind a completed sibling without explicit inheritance',()=>{
  const order=fixture(),first=node(order,'process_logistics');first.state='completed';first.round=1;
  const stage=order.stages.find(stage=>stage.key==='post_cutting')!;
  stage.nodes.push({...first,instanceId:'retired-white',subject:'白PO · 乙厂',current:false,state:'active'});
  const requirement=()=>journeyBusinessProgress(order,asOf).requirements.find(row=>row.key==='process_logistics')!;
  expect(requirement()).toMatchObject({applicability:'unknown',completed:false});
  expect(requirement().reasons).toContain('白PO · 乙厂退役后的有效承接范围尚未核实');
  first.state='inherited';first.inheritedFrom={taskId:'retired-white',round:1};
  expect(requirement()).toMatchObject({applicability:'applicable',completed:true});
  first.state='not_applicable';first.progressApplicability='not_applicable';first.inheritedFrom=null;
  expect(requirement()).toMatchObject({applicability:'not_applicable',completed:false});
});
it('P01-08: unavailable scope never becomes completed or zero missing requirements',()=>{
  const order=fixture();node(order,'bulk_cutting').state='unavailable';
  expect(journeyBusinessProgress(order,asOf,'unavailable')).toMatchObject({unknown:1,ratio:null,plan:{status:'unavailable',covered:0,due:0}});
});
it('native material return chains reach the current same-kind recheck without cross-round inheritance',()=>{
  const order=fixture(),first=node(order,'development_materials');first.current=false;first.round=1;
  const middle={...first,instanceId:'returned-recheck',key:'development_material_recheck'};
  const current={...middle,instanceId:'current-recheck',current:true,state:'completed' as const};
  order.stages.find(stage=>stage.key==='development')!.nodes.push(middle,current);
  const read=(links:Array<{retiredId:string;successorId:string}>)=>journeyBusinessProgress(order,asOf,null,undefined,new Map(),links).requirements.find(row=>row.key==='development_materials')!;
  expect(read([])).toMatchObject({applicability:'unknown',completed:false});
  expect(read([{retiredId:first.instanceId,successorId:middle.instanceId}])).toMatchObject({applicability:'unknown',completed:false});
  expect(read([{retiredId:first.instanceId,successorId:middle.instanceId},{retiredId:middle.instanceId,successorId:current.instanceId}])).toMatchObject({applicability:'applicable',completed:true});
  expect(read([{retiredId:first.instanceId,successorId:middle.instanceId},{retiredId:middle.instanceId,successorId:first.instanceId}])).toMatchObject({applicability:'unknown',completed:false});
  expect(current.inheritedFrom).toBeNull();
});
it('P01-09/11: actual and adopted plan use the same nine requirements and compare identities, not just equal totals',()=>{
  const order=fixture();for(const key of [selected[0]!,selected[1]!,selected[5]!])node(order,key).state='completed';
  const result=journeyBusinessProgress(order,asOf,plan());
  expect(result).toMatchObject({applicable:9,completed:3,ratio:1/3,plan:{status:'complete',covered:9,due:4}});
  expect(result.plan.outstandingDue).toEqual(['development_pattern:whole','bulk_pattern:whole']);
  const partial=journeyBusinessProgress(order,asOf,plan(selected.slice(0,6)));
  expect(partial.plan).toMatchObject({status:'partial',covered:6,missing:3,due:4});
  order.businessProgress=partial;const html=renderToStaticMarkup(createElement(CockpitBusinessProgress,{order}));
  expect(html).toContain('已有计划的6项中');expect(html).toContain('另3项尚无完整对应计划日期');expect(html).not.toContain('4/9');
});
it('P01-10: an unadopted preview does not replace V1; explicit V2 adoption changes targets without changing actual facts',()=>{
  const order=fixture(),adopted=plan();node(order,'bulk_cutting').state='completed';
  const before=journeyBusinessProgress(order,asOf,adopted),preview=plan(selected,2);
  expect(journeyBusinessProgress(order,asOf,adopted)).toEqual(before);expect(preview.revision).toBe(2);
  const after=journeyBusinessProgress(order,asOf,preview);expect(after.plan.revision).toBe(2);expect(after.completed).toBe(before.completed);
  expect(journeyBusinessProgress(order,asOf).plan.status).toBe('not_adopted');
});
it('date-only plan targets become due at Beijing end-of-day, independently of instantaneous targets',()=>{
  const order=fixture(),adopted=plan(['bulk_cutting']);adopted.targets=new Map([['bulk_cutting',[{...target('bulk_cutting'),at:'2026-11-05'}]]]);
  expect(journeyBusinessProgress(order,'2026-11-05T15:59:59.999Z',adopted).plan.due).toBe(0);
  expect(journeyBusinessProgress(order,'2026-11-05T16:00:00.000Z',adopted).plan.due).toBe(1);
});
const snapshot=(revision:number,retainedFromRevision:number|null=null)=>({revision,milestones:[{key:'client_sample_approval',scopeRef:'whole',targetDate:'2026-11-04',retainedFromRevision}],dependencies:[]} as unknown as SeriesPlanSnapshot);
it('P01-11: partial application retains the original adoption identity and missing old provenance stays uncovered',()=>{
  const old={planId:'V1',snapshot:snapshot(1)},current={planId:'V2',snapshot:snapshot(2,1)};
  expect(adoptedJourneyTargets(current,[current,old],[]).targets.get('customer_sample')).toEqual([{source:'series_plan',planId:'V1',revision:1,scopeRef:'whole',at:'2026-11-04',precision:'date',retainedFromRevision:1}]);
  expect(adoptedJourneyTargets(current,[current],[]).targets.has('customer_sample')).toBe(false);
});
it('an adopted dependency covering only one of two PO scopes cannot supply a whole-order plan target',()=>{
  const current={planId:'V1',snapshot:{...snapshot(1),dependencies:[{id:'cutting:po:one',scopeRef:'po:one',basis:'confirmed',endAt:asOf}] as SeriesPlanSnapshot['dependencies']}};
  expect(adoptedJourneyTargets(current,[current],['one','two']).targets.has('bulk_cutting')).toBe(false);
  expect(adoptedJourneyTargets(current,[current],['one']).targets.get('bulk_cutting')).toHaveLength(1);
});
it('P02-11: one invalid original PO timestamp cannot leave a complete target for the other PO',()=>{
  const current={planId:'V2',snapshot:{...snapshot(2),dependencies:[{id:'cutting:po:one',scopeRef:'po:one',basis:'confirmed',endAt:'2026-11-05T08:00:00'},{id:'cutting:po:two',scopeRef:'po:two',basis:'confirmed',endAt:asOf}] as SeriesPlanSnapshot['dependencies']}};
  expect(adoptedJourneyTargets(current,[current],['one','two']).targets.has('bulk_cutting')).toBe(false);
  current.snapshot.dependencies![0]!.endAt='2026-11-05T08:00:00+08:00';
  expect(adoptedJourneyTargets(current,[current],['one','two']).targets.get('bulk_cutting')).toHaveLength(2);
});
function closure(received:number,covered:number,packed:number,demand=received):OrderClosureSheet{return {revision:'closure-v1',lines:[{lineId:'PO-WHITE',orderedQuantity:demand,actualQuantity:received,packingQuantity:packed}],quality:[{receiptId:'receipt-1',lineId:'PO-WHITE',quantity:covered,inspected:true,qualifiedQuantity:covered}]} as unknown as OrderClosureSheet;}
it('P01-06: I cumulative 1→2 with one inspected receipt and packing 2 retains the quality gap despite quantity completion',()=>{
  const quantities=journeyBusinessQuantities(closure(2,1,2));expect(quantities.lines[0]).toMatchObject({received:2,inspected:1,qualityGap:1,packed:2,remainingShipment:0});
  const order=fixture();node(order,'receiving_inspection').state='completed';node(order,'receiving_inspection').progressApplicability='applicable';
  const result=journeyBusinessProgress(order,asOf,null,quantities);expect(result.requirements.find(row=>row.key==='receiving_inspection')).toMatchObject({applicability:'applicable',completed:false});
});
it('P01-07: F global receipt/QC/packing 2 of 4 stays known with two missing; factory attribution stays unknown',()=>{
  expect(journeyBusinessQuantities(closure(2,2,2,4))).toMatchObject({factoryAttribution:'unknown',lines:[{received:2,inspected:2,qualityGap:0,packed:2,remainingReceipt:2,remainingShipment:2}]});
});
it('quality reads that are absent remain unknown; duplicate receipt identities do not multiply coverage',()=>{
  const value=closure(2,1,2);value.quality!.push({...value.quality![0]!});expect(journeyBusinessQuantities(value).lines[0]!.inspected).toBe(1);
  delete value.quality;expect(journeyBusinessQuantities(value).lines[0]).toMatchObject({inspected:null,qualified:null,qualityGap:null});
});
it('a downward cumulative correction retains original inspection facts and exposes excess coverage rather than passing quality',()=>{
  const quantities=journeyBusinessQuantities(closure(1,2,1));
  expect(quantities.lines[0]).toMatchObject({received:1,inspected:2,qualityGap:0,qualityConflict:true});
  const order=fixture();node(order,'receiving_inspection').state='completed';node(order,'receiving_inspection').progressApplicability='applicable';
  const result=journeyBusinessProgress(order,asOf,null,quantities);
  expect(result.requirements.find(row=>row.key==='receiving_inspection')).toMatchObject({completed:false,applicability:'applicable'});
  order.businessProgress=result;expect(renderToStaticMarkup(createElement(CockpitBusinessProgress,{order}))).toContain('原质检覆盖与当前有效实收范围不一致');
});
it('precise receipt factory links remain known only while they cover the effective cumulative quantity',()=>{
  const value=closure(1,1,1);value.lines[0]!.receipts=[{receiptId:'receipt-1',receivedAt:asOf,actualQuantity:1,defectiveQuantity:0}];
  expect(journeyBusinessQuantities(value,new Set(['receipt-1'])).factoryAttribution).toBe('known');
  value.lines[0]!.actualQuantity=2;expect(journeyBusinessQuantities(value,new Set(['receipt-1'])).factoryAttribution).toBe('unknown');
});
it('P01-05: native sample evidence replaces a virtual progress obligation without completing the original task or wages',()=>{
  const order=fixture();node(order,'bulk_ship_sample').state='pending';node(order,'bulk_ship_sample').progressApplicability='applicable';
  const before=structuredClone(node(order,'bulk_ship_sample'));
  const result=journeyBusinessProgress(order,asOf,null,undefined,new Map([['bulk_ship_sample',{applicability:'applicable',completed:true,reason:'全部PO有原船样寄出证据',instanceIds:['sample-event']}]]));
  expect(result.requirements.find(row=>row.key==='bulk_ship_sample')?.completed).toBe(true);expect(node(order,'bulk_ship_sample')).toEqual(before);
});

it('keeps a recorded packing count distinct from qualified delivery and its unknown remaining shipment',()=>{
 const value=closure(4,4,4);value.quality![0]!.qualifiedQuantity=3;value.lines[0]!.effectivePackingQuantity=null;
 expect(journeyBusinessQuantities(value).lines[0]).toMatchObject({packed:4,effectivePacked:null,remainingShipment:null,qualityGap:0});
});
