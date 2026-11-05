import {expect,it} from 'vitest';
import {JourneyFilterSchema,JOURNEY_NODES,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {evaluateSlaPlan,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {attachJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
import {journeyStages,selectJourneys} from '../../apps/api/src/production-platform/journey-projection.js';
import {journeyDisplay} from '../../apps/api/src/production-platform/journey-display.js';
import {todoSlaTiming,explicitlyUnlimitedSla} from '../../apps/api/src/todos/sla-presentation.js';
import {slaTargetLabel} from '../../apps/web/src/journey-sla-details.js';
const now='2026-10-20T00:00:00.000Z',time={now,scenarioId:null,revision:0};
const plan=(kind:'duration'|'order_date'|'estimate'='duration'):SlaPlan=>({nodes:[{id:'development_pattern',label:'纸样',stage:2,parameterKey:'development_pattern',kind,minutes:120,offsetDays:null,applicable:'yes',countsProgress:true,dependsOn:[],anchorKey:'published',targetKey:kind==='order_date'?'target':null,includedIn:null,includedPosition:'start'}],anchors:{published:{precision:'instant',value:'2026-10-19T00:00:00.000Z',source:'native'},target:{precision:'date',value:'2026-10-20',source:'native-po'}},warningPercent:70,stageBufferMinutes:0});
function order(id='one'):OrderJourney{
 const nodes:JourneyNode[]=JOURNEY_NODES.map(d=>({key:d.key,label:d.label,stage:d.stage,instanceId:d.key,state:d.key==='order_information'?'completed':'active',current:true,round:null,occurrence:null,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,progressApplicability:'applicable'}));
 return {id,sourceId:null,orderId:id,designStyleNo:id,temporaryStyleNo:null,customer:'TEST',category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:now,deliveryDate:null,selectedRound:null,adoptedRound:null,sourceVersion:null,instructionVersion:null,lines:[{id:'po',po:'PO',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:10}],poDeliveryDates:[],links:[],stages:journeyStages(nodes),progress:{development:null,bulk:null},hitReasons:[]};
}
it('keeps known local overdue with missing customer/factory dates; filters original orders without hiding computable risk',()=>{
 const o=order(),p=plan();attachJourneySupervision(o,p,p,evaluateSlaPlan(p,{development_pattern:{startedAt:'2026-10-19T00:00:00.000Z',evidence:'task'}},time),time,{original:1,current:2});o.display=journeyDisplay(o,now);
 const result=selectJourneys([o],JourneyFilterSchema.parse({scope:'production',missing:'customer_date'}),now);
 expect(result.summary.overdue).toBe(0);expect(result.supervision?.overdue).toBe(1);expect(result.supervision?.coverage).toEqual(expect.arrayContaining([expect.objectContaining({key:'customer_date',orders:1}),expect.objectContaining({key:'factory_date',orders:1})]));expect(result.total).toBe(1);
 const n=o.stages.flatMap(s=>s.nodes).find(n=>n.key==='development_pattern')!;expect(n.risks).toContain('overdue');expect(n.state).toBe('active');
});
it('retains P0 while current standard and clock move, and business progress ignores elapsed time/receipt collection',()=>{
 const o=order(),p=plan(),newPlan=plan();newPlan.nodes[0]!.minutes=240;
 const before=journeyDisplay(o,now).actualRatio;attachJourneySupervision(o,newPlan,p,evaluateSlaPlan(newPlan,{},time),time,{original:1,current:2});
 expect(o.supervision!.nodes[0]!.original.at).not.toBe(o.supervision!.nodes[0]!.current.at);expect(journeyDisplay(o,'2027-01-01T00:00:00Z').actualRatio).toBe(before);
 o.stages.flatMap(s=>s.nodes).find(n=>n.key==='receipts')!.state='completed';const display=journeyDisplay(o,now);expect(display.actualRatio).not.toBe(1);expect(display.mainState).not.toBe('completed');
});
it('retains business completion with missing actual time; no new task/state or inferred C',()=>{
 const o=order(),p=plan(),n=o.stages.flatMap(s=>s.nodes).find(n=>n.key==='development_pattern')!;n.state='completed';
 attachJourneySupervision(o,p,p,evaluateSlaPlan(p,{development_pattern:{businessCompleted:true,evidence:'native'}},time),time,{original:1,current:1});
 expect(n.state).toBe('completed');expect(n.timing?.status).toBe('completed_unrated');expect(n.actualAt).toBeNull();expect(n.risks).not.toContain('overdue');
});
it('uses next Beijing midnight exclusively, and precise duration equality remains on time',()=>{
 const date=plan('order_date'),before={...time,now:'2026-10-20T15:59:59.999Z'},end={...time,now:'2026-10-20T16:00:00.000Z'};
 expect(evaluateSlaPlan(date,{},before)[0]!.status).not.toBe('overdue');const at=evaluateSlaPlan(date,{},end)[0]!;expect(at.status).toBe('overdue');expect(slaTargetLabel(at.deadline)).toContain('2026/10/20');expect(slaTargetLabel(at.deadline)).toContain('当天结束');
 expect(todoSlaTiming({dueAt:now,warningAt:'2026-10-19T23:00:00Z',enteredAt:null,asOf:now,exclusive:false}).status).toBe('warning');expect(todoSlaTiming({dueAt:now,warningAt:null,enteredAt:null,asOf:now,exclusive:true}).status).toBe('overdue');
});
it('never turns logistics estimate or missing warning/start into a hard or normal SLA',()=>{
 const o=order(),p=plan('estimate');attachJourneySupervision(o,p,p,evaluateSlaPlan(p,{},time),time,{original:1,current:1});expect(o.supervision!.nodes[0]!.target.at).toBeNull();
 expect(todoSlaTiming({dueAt:null,warningAt:null,enteredAt:null,asOf:now}).status).toBe('unknown');expect(todoSlaTiming({dueAt:'2026-10-21T00:00:00Z',warningAt:null,enteredAt:null,asOf:now}).status).toBe('unknown');expect(todoSlaTiming({dueAt:'2026-10-19T00:00:00Z',warningAt:null,enteredAt:null,asOf:now}).status).toBe('overdue');
 expect(todoSlaTiming({dueAt:null,warningAt:null,enteredAt:null,asOf:now,unlimited:true}).status).toBe('unlimited');
});
it('legacy supervision never manufactures P0 or task completion; cancelled orders do not enter local risk counts',()=>{
 const o=order();attachJourneySupervision(o,null,null,[],time,{original:null,current:null});expect(o.supervision?.nodes).toEqual([]);expect(o.supervision?.coverage.some(c=>c.key==='plan')).toBe(true);
 o.display=journeyDisplay(o,now,{cancelled:true});expect(selectJourneys([o],JourneyFilterSchema.parse({scope:'production'}),now).supervision?.overdue).toBe(0);
});
it('preserves outsourced cutting timing, while missing internal C stays a precision limit without new recording',()=>{
 const p=plan();Object.assign(p.nodes[0]!,{id:'bulk_cutting',parameterKey:'bulk_cutting',stage:4});const o=order();
 attachJourneySupervision(o,p,p,evaluateSlaPlan(p,{},time),time,{original:1,current:1},true);expect(o.supervision!.nodes).toEqual([]);expect(o.supervision!.coverage.some(c=>c.key==='cutting_time')).toBe(false);
 attachJourneySupervision(o,p,p,evaluateSlaPlan(p,{},time),time,{original:1,current:1});expect(o.supervision!.coverage.find(c=>c.key==='cutting_time')?.message).toContain('不增加收布填报');
});
it('keeps PO aggregate risk without inventing a single target from several PO windows',()=>{
 const o=order(),p=plan('order_date');p.nodes=[1,2].map(i=>({...p.nodes[0]!,id:`factory_production:PO${i}`,parameterKey:'factory_production',stage:6,targetKey:`target${i}`}));p.anchors.target1={precision:'date',value:'2026-10-19',source:'native'};p.anchors.target2={precision:'date',value:'2026-10-21',source:'native'};
 attachJourneySupervision(o,p,p,evaluateSlaPlan(p,{},time),time,{original:1,current:1});const raw=o.stages.flatMap(s=>s.nodes).find(n=>n.key==='factory_production_qc')!;
 expect(raw.risks).toContain('overdue');expect(raw.timing).toBeUndefined();expect(raw.expectedAt).toBeNull();
});

it('retains late completion history without counting an ended task as an in-progress overdue task',()=>{
 const o=order(),n=o.stages.flatMap(s=>s.nodes).find(n=>n.key==='development_pattern')!;n.state='completed';n.risks=['overdue'];
 o.display=journeyDisplay(o,now);const result=selectJourneys([o],JourneyFilterSchema.parse({scope:'production'}),now);
 expect(n.risks).toEqual(['overdue']);expect(result.supervision?.overdue).toBe(0);
});

it('distinguishes unknown batch windows from captured unlimited rule types',()=>{
 for(const parameterKey of ['process_logistics','bulk_qc','warehouse_dispatch','development_pattern','external_pattern','ship_sample_advance']){
  const basis={parameterKey,seconds:null,snapshotId:'frozen-window',basis:[]};
  expect(explicitlyUnlimitedSla(basis)).toBe(false);
  expect(todoSlaTiming({dueAt:null,warningAt:null,enteredAt:null,asOf:now,unlimited:explicitlyUnlimitedSla(basis)}).status).toBe('unknown');
 }
 for(const parameterKey of ['development_shipping','budget','warehouse_accessories'])expect(explicitlyUnlimitedSla({parameterKey,seconds:null})).toBe(true);
 for(const basis of [null,undefined,[],{seconds:null},{parameterKey:'not_known',seconds:null},{parameterKey:'budget',seconds:3600}])expect(explicitlyUnlimitedSla(basis)).toBe(false);
});

it('does not turn a task chronology marked unknown into a normal todo merely because a warning exists',()=>{
 const result=todoSlaTiming({enteredAt:'2026-10-21T00:00:00.000Z',dueAt:'2026-10-22T00:00:00.000Z',warningAt:'2026-10-21T12:00:00.000Z',asOf:'2026-10-20T00:00:00.000Z'});expect(result.status).toBe('unknown');expect(result.elapsedSeconds).toBeNull();
});

it('P02-04: preserves a frozen 72h plan and reads the actual 24h instruction window without catalogue replacement',()=>{
 const original=plan();Object.assign(original.nodes[0]!,{id:'production_sheet',parameterKey:'production_sheet',stage:3,minutes:4320});
 const start='2026-10-19T00:00:00.000Z';
 for(const [minutes,expected] of [[1440,'2026-10-20T00:00:00.000Z'],[4320,'2026-10-22T00:00:00.000Z']] as const){
  const o=order(),facts={production_sheet:{startedAt:start,standardMinutes:minutes,evidence:`TEST original frozen instruction window ${minutes}`}};
  attachJourneySupervision(o,original,original,evaluateSlaPlan(original,facts,time),time,{original:1,current:1},false,{facts});
  expect(o.supervision!.nodes[0]!.target.at).toBe(expected);
  expect(o.supervision!.nodes[0]!.original.at).toBe('2026-10-22T00:00:00.000Z');
  expect(o.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='production_instruction')!.expectedAt).toBe(expected);
 }
 expect(original.nodes[0]!.minutes).toBe(4320);
});

it('P02-05: both original sourcing 2h windows keep independent D and agree with todo timing at D minus1ms, D and D plus1ms',()=>{
 const p=plan(),base=p.nodes[0]!;
 p.nodes=[{...base,id:'sourcing_selection',parameterKey:'sourcing_selection',stage:3},{...base,id:'sourcing_approval',parameterKey:'sourcing_approval',stage:3}];
 const facts={sourcing_selection:{startedAt:'2026-10-19T00:00:00.000Z',evidence:'TEST actual factory selection'},sourcing_approval:{startedAt:'2026-10-19T03:00:00.000Z',evidence:'TEST actual owner approval'}};
 for(const [id,key,deadline,warning] of [['sourcing_selection','sourcing_director','2026-10-19T02:00:00.000Z','2026-10-19T01:24:00.000Z'],['sourcing_approval','sourcing_owner','2026-10-19T05:00:00.000Z','2026-10-19T04:24:00.000Z']] as const)for(const offset of [-1,0,1]){
  const observed={...time,now:new Date(Date.parse(deadline)+offset).toISOString()},o=order();
  const visibleFacts=Date.parse(observed.now)<Date.parse(facts.sourcing_approval.startedAt)?{sourcing_selection:facts.sourcing_selection}:facts;
  const evaluations=evaluateSlaPlan(p,visibleFacts,observed),row=evaluations.find(node=>node.id===id)!;
  attachJourneySupervision(o,p,p,evaluations,observed,{original:1,current:1},false,{facts:visibleFacts});
  const native=o.stages.flatMap(stage=>stage.nodes).find(node=>node.key===key)!;
  const todo=todoSlaTiming({dueAt:deadline,warningAt:warning,enteredAt:facts[id].startedAt,asOf:observed.now});
  expect(native.expectedAt).toBe(deadline);expect(row.deadline.at).toBe(deadline);
  expect(todo.status).toBe(offset>0?'overdue':'warning');expect(row.status).toBe(todo.status);
  expect(native.risks.includes('overdue')).toBe(offset>0);
 }
});
