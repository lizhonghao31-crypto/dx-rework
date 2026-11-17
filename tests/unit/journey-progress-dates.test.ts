import {expect,it} from 'vitest';
import {JOURNEY_NODES,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {evaluateSlaPlan,type SlaNodeFact,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {journeyStages} from '../../apps/api/src/production-platform/journey-projection.js';
import {journeyBusinessProgress,type AdoptedRequirementPlan} from '../../apps/api/src/production-platform/journey-business-progress.js';
import {journeyBusinessDates} from '../../apps/api/src/production-platform/journey-progress-dates.js';
import {attachJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
import {journeyVisualProgress} from '../../apps/api/src/production-platform/journey-visual-progress.js';

const now='2026-11-05T00:00:00.000Z',time={now,scenarioId:null,revision:0};
function fixture(keys=['bulk_pattern','bulk_cutting']):OrderJourney{
 const nodes:JourneyNode[]=JOURNEY_NODES.map(definition=>({...definition,instanceId:definition.key,state:keys.includes(definition.key)?'active':'not_applicable',current:true,round:1,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:false,unavailableReason:null,progressApplicability:keys.includes(definition.key)?'applicable':'not_applicable'}));
 return {id:'mother',sourceId:'source',orderId:'mother',designStyleNo:'TEST-DATES',temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:now,deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:1,lines:[],links:[],stages:journeyStages(nodes),progress:{development:null,bulk:null},hitReasons:[]};
}
const node=(order:OrderJourney,key:string)=>order.stages.flatMap(stage=>stage.nodes).find(node=>node.key===key)!;
const adopt=(keys=['bulk_pattern','bulk_cutting'],revision=1,date='2026-11-10'):AdoptedRequirementPlan=>({planId:`adopted-${revision}`,revision,targets:new Map(keys.map(key=>[key,[{source:'series_plan' as const,planId:`adopted-${revision}`,revision,scopeRef:'whole',at:date,precision:'date' as const,retainedFromRevision:null}]]))});
const read=(order:OrderJourney,plan:AdoptedRequirementPlan|null=null)=>{order.businessProgress=journeyBusinessProgress(order,now,plan);return journeyBusinessDates(order);};
function supervise(order:OrderJourney,fact:SlaNodeFact|undefined,key='bulk_pattern'){
 const plan:SlaPlan={nodes:[{id:key,label:key,stage:key==='bulk_cutting'?4:3,parameterKey:key,kind:'duration',minutes:120,offsetDays:null,applicable:'yes',countsProgress:true,dependsOn:[],anchorKey:'publication',targetKey:null,includedIn:null,includedPosition:'start'}],anchors:{publication:{precision:'instant',value:now,source:'TEST native publication'}},warningPercent:70,stageBufferMinutes:0};
 const facts=fact?{[key]:fact}:{};
 attachJourneySupervision(order,plan,plan,evaluateSlaPlan(plan,facts,time,{mode:'read_projection'}),time,{original:1,current:1},false,{facts});
 return plan;
}

it('matches a recheck plan alias only to its own task when projecting completion dates and forecasts',()=>{
 const order=fixture(['development_material_recheck']),own=node(order,'development_material_recheck');
 own.instanceId='TEST-recheck';own.enteredAt='2026-11-04T23:00:00.000Z';
 supervise(order,{startedAt:own.enteredAt,evidence:'task:TEST-recheck'},'development_materials:task:TEST-recheck');
 expect(read(order).overall.forecast).toMatchObject({status:'complete',at:'2026-11-05T01:00:00.000Z'});
 order.supervision!.nodes[0]!.id='development_materials:task:TEST-foreign-recheck';
 expect(read(order).overall.forecast.at).toBeNull();
});

it('P02-02: a partially completed execution range never provides a whole-phase actual completion date',()=>{
 const order=fixture(['bulk_cutting']),first=node(order,'bulk_cutting');first.state='completed';first.actualDate='2026-11-04';first.actualQuality='unverified';
 const second:JourneyNode={...first,instanceId:'second-po',subject:'白PO · 乙厂',state:'active',actualDate:null};
 order.stages.find(stage=>stage.key==='cutting')!.nodes.push(second);
 expect(read(order).overall.actual).toMatchObject({status:'incomplete',at:null,total:1});
 second.state='completed';second.actualDate='2026-11-04';
 expect(read(order).overall.actual).toMatchObject({status:'complete',at:'2026-11-04',precision:'date',quality:'recorded'});
 second.actualDate=null;second.actualAt='2026-11-04T06:00:00.000Z';second.actualQuality='verified';
 expect(read(order).overall.actual).toMatchObject({at:'2026-11-04',precision:'date'});
 second.actualAt='2026-11-05T00:00:00.000Z';
 expect(read(order).overall.actual).toMatchObject({at:now,precision:'instant',quality:'recorded'});
});

it('P02-03: inherited original completion is not a new-round adoption or phase completion time',()=>{
 const order=fixture(['development_pattern']),current=node(order,'development_pattern');order.adoptedRound=2;order.selectedRound=2;current.round=2;
 const old={...current,instanceId:'r1-result',current:false,round:1,state:'completed' as const,actualAt:'2026-11-01T00:00:00.000Z',actualQuality:'verified' as const};
 order.stages.find(stage=>stage.key==='development')!.nodes.push(old);
 current.state='inherited';current.inheritedFrom={taskId:old.instanceId,round:1};
 const result=read(order);
 expect(result.overall.actual).toMatchObject({status:'unknown',at:null});
 expect(result.overall.actual.reasons.join('；')).toContain('本轮采用完成时间尚未取得');
 expect(old.actualAt).toBe('2026-11-01T00:00:00.000Z');
});

it('Final10 an explicit effective round adoption supplies this-round completion without copying original work time',()=>{
 const order=fixture(['development_pattern']),current=node(order,'development_pattern');
 order.adoptedRound=2;order.selectedRound=2;current.round=2;current.state='inherited';current.inheritedFrom={taskId:'TEST-original',round:1};
 current.inheritedResult={actualAt:'2026-11-01T00:00:00Z',quality:'verified',adoptedAt:'2026-11-04T06:00:00Z',adoptedRound:2,adoptionSourceRef:'development-round:source:2',reason:'本轮发布时沿用'};
 expect(read(order).overall.actual).toMatchObject({status:'complete',at:'2026-11-04T06:00:00Z',precision:'instant',quality:'recorded'});
 expect(current.actualAt).toBeNull();expect(current.enteredAt).toBeNull();
 current.inheritedResult.adoptedRound=1;expect(read(order).overall.actual.at).toBeNull();
 current.inheritedResult.adoptedRound=2;current.inheritedResult.adoptedAt='2026-11-06T00:00:00Z';expect(read(order).overall.actual.at).toBeNull();
});

it('Final10 real completed gate and running native task retain a whole forecast and visual window without manufacturing a gate event',()=>{
 const order=fixture(['bulk_cutting','cutting_gate']),gate=node(order,'cutting_gate'),task=node(order,'bulk_cutting');
 gate.state='completed';gate.instanceId='cutting_gate:0';gate.round=null;
 task.enteredAt='2026-11-04T23:00:00.000Z';task.occurrence=1;
 supervise(order,{startedAt:task.enteredAt,evidence:'TEST original active cutting'},'bulk_cutting');
 const dates=read(order);order.businessProgress!.dates=dates;
 expect(dates.overall.forecast).toMatchObject({status:'complete',at:'2026-11-05T01:00:00.000Z',covered:2,total:2,bases:['standard_window']});
 expect(dates.overall.actual).toMatchObject({status:'incomplete',at:null});
 const visual=journeyVisualProgress(order,now);
 expect(visual).toMatchObject({startedAt:task.enteredAt,timeRatio:null,actualRatio:.5,delivery:{status:'unknown',at:null}});
 // The stage retains its native two-hour window. The whole-order delivery
 // bar must not turn that forecast into an absent customer commitment.
 expect(visual.stages.find(stage=>stage.key==='cutting')?.timeRatio).toBe(.5);
 order.lines=[{id:'TEST delivery PO',po:'TEST-PO',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}];
 order.poDeliveryDates=[{lineId:'TEST delivery PO',customerWarehouseArrivalDate:'2026-11-05'} as NonNullable<OrderJourney['poDeliveryDates']>[number]];
 // 07:00 Beijing start, 08:00 observation, next midnight deadline: 1/17.
 expect(journeyVisualProgress(order,now)).toMatchObject({startedAt:task.enteredAt,timeRatio:1/17,actualRatio:.5});
 expect(gate).toMatchObject({state:'completed',actualAt:null,enteredAt:null});
 task.state='completed';task.actualAt=null;task.actualQuality='missing';
 expect(read(order).overall.forecast.at).toBeNull();
});

it.each(['instant','date'])('Final10 a contradictory completed %s cannot masquerade as a merely missing past timestamp',precision=>{
 const order=fixture(['bulk_cutting','cutting_gate']),gate=node(order,'cutting_gate'),task=node(order,'bulk_cutting');
 gate.state='completed';gate.instanceId='cutting_gate:0';gate.round=null;gate.actualQuality='verified';
 if(precision==='date')gate.actualDate='2026-11-06';else gate.actualAt='2026-11-06T00:00:00Z';
 task.enteredAt='2026-11-04T23:00:00.000Z';supervise(order,{startedAt:task.enteredAt,evidence:'TEST original current task'},'bulk_cutting');
 expect(read(order).overall.forecast).toMatchObject({status:'partial',at:null,covered:1,total:2});
});

it('P02-11: partial adoption retains a covered-range date without promoting it to a whole-order target',()=>{
 const order=fixture(),result=read(order,adopt(['bulk_pattern']));
 expect(result.overall.adoptedPlan).toMatchObject({status:'partial',at:null,covered:1,total:2,coveredAt:{at:'2026-11-10',precision:'date'},planId:'adopted-1',revision:1});
 expect(result.stages.find(stage=>stage.key==='preparation')!.adoptedPlan).toMatchObject({status:'complete',at:'2026-11-10'});
 expect(result.stages.find(stage=>stage.key==='cutting')!.adoptedPlan).toMatchObject({status:'unknown',at:null});
 const missing=read(order);
 expect(missing.overall.adoptedPlan).toMatchObject({status:'unknown',at:null,sourcePlans:[]});
 expect(missing.overall.adoptedPlan.reasons.join('；')).toContain('尚未取得已采用');
});

it('P02-11: canonical forecast classes retain their own sources instead of claiming P-series adoption',()=>{
 const order=fixture(['bulk_pattern']);
 supervise(order,{startedAt:'2026-11-04T23:00:00.000Z',remaining:{minutes:30,asOf:now,validUntil:'2026-11-05T01:00:00.000Z',source:'TEST valid native assessment'},evidence:'TEST original task'});
 expect(read(order).overall.forecast).toMatchObject({status:'complete',at:'2026-11-05T00:30:00.000Z',bases:['remaining_estimate']});
 supervise(order,{startedAt:'2026-11-04T23:00:00.000Z',evidence:'TEST original task'});
 expect(read(order).overall.forecast).toMatchObject({status:'complete',at:'2026-11-05T01:00:00.000Z',bases:['standard_window']});
 supervise(order,undefined);
 const systemPlan=read(order);
 expect(systemPlan.overall.forecast).toMatchObject({status:'complete',at:'2026-11-05T02:00:00.000Z',bases:['sla_plan']});
 expect(systemPlan.overall.adoptedPlan.status).toBe('unknown');
 const actual=node(order,'bulk_pattern');actual.state='completed';actual.actualAt='2026-11-04T23:00:00.000Z';actual.actualQuality='verified';
 expect(read(order).overall.forecast).toMatchObject({status:'complete',at:actual.actualAt,bases:['actual']});
});

it('P02-12: expired estimates and mismatched observation snapshots do not survive as current forecasts',()=>{
 const order=fixture(['bulk_pattern']);
 supervise(order,{startedAt:'2026-11-04T23:00:00.000Z',remaining:{minutes:30,asOf:'2026-11-04T23:00:00.000Z',validUntil:'2026-11-04T23:59:59.000Z',source:'TEST expired assessment'},evidence:'TEST original task'});
 expect(read(order).overall.forecast).toMatchObject({status:'unknown',at:null});
 expect(read(order).overall.forecast.reasons.join('；')).toContain('失效');
 supervise(order,undefined);order.supervision!.asOf='2026-11-04T23:59:59.999Z';
 expect(read(order).overall.forecast.reasons.join('；')).toContain('请刷新');
 order.supervision!.asOf='2026-11-05T08:00:00+08:00';
 expect(read(order).overall.forecast.status).toBe('complete');
});

it('P02-12: V2 dates retain each real adoption origin and never recalculate original actual completion',()=>{
 const order=fixture(),pattern=node(order,'bulk_pattern');pattern.state='completed';pattern.actualAt='2026-11-04T01:00:00.000Z';pattern.actualQuality='verified';
 const before=read(order,adopt());
 const version2=adopt(undefined,2,'2026-11-12');version2.targets=new Map([...version2.targets].map(([key,targets])=>[key,key==='bulk_pattern'?[{...targets[0]!,planId:'adopted-1',revision:1,at:'2026-11-10',retainedFromRevision:1}]:targets]));
 const after=read(order,version2);
 expect(before.overall.adoptedPlan.at).toBe('2026-11-10');expect(after.overall.adoptedPlan.at).toBe('2026-11-12');
 expect(after.overall.adoptedPlan.sourcePlans).toEqual(expect.arrayContaining([{planId:'adopted-1',revision:1},{planId:'adopted-2',revision:2}]));
 expect(pattern.actualAt).toBe('2026-11-04T01:00:00.000Z');
});

it('P02-10: contradictory actual times and incomplete per-scope forecasts stay unassessed',()=>{
 const order=fixture(['bulk_pattern']),first=node(order,'bulk_pattern');first.state='completed';first.actualAt='2026-11-06T00:00:00.000Z';first.actualQuality='verified';
 expect(read(order).overall.actual).toMatchObject({status:'unknown',at:null});
 first.state='active';first.actualAt=null;supervise(order,undefined);
 order.stages.find(stage=>stage.key==='preparation')!.nodes.push({...first,instanceId:'second-scope'});
 expect(read(order).overall.forecast).toMatchObject({status:'unknown',at:null});
 expect(read(order).overall.forecast.reasons.join('；')).toContain('多个执行范围');
});
it('P02-10: unavailable timing reads and denied timing scope retain different reasons without inviting an ineffective refresh',()=>{
 const order=fixture(['bulk_pattern']);
 expect(read(order).overall.forecast.reasons.join('；')).toContain('尚未取得本次完整时效读取');
 supervise(order,undefined);order.supervision!.status='limited';order.supervision!.nodes=[];
 const denied=read(order).overall.forecast;
 expect(denied).toMatchObject({status:'unknown',at:null});expect(denied.reasons.join('；')).toContain('当前岗位权限');expect(denied.reasons.join('；')).not.toContain('请刷新');
});
