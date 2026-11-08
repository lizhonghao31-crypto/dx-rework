import {describe,expect,it,vi} from 'vitest';
import type {PoolClient} from 'pg';
import {JOURNEY_STAGES,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {journeyDisplay} from '../../apps/api/src/production-platform/journey-display.js';
import {journeySelectionFacts,type JourneySelectionTask} from '../../apps/api/src/production-platform/journey-selection-facts.js';
import {journeyObservedDay,journeyPlanDateOverdue,journeyTaskTimeRisks} from '../../apps/api/src/production-platform/journey-risk-clock.js';
import {compileJourneySelectionClock} from '../../apps/api/src/production-platform/journey-selection-clock.js';
import {journeySelectionNodes} from '../../apps/api/src/production-platform/journey-selection-facts.js';
import {attachJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
import {evaluateSlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {poDeliveryRisks} from '@dx-rework/contracts';
import {developmentNativeFacts} from '../../apps/api/src/production-platform/development-sla-evidence.js';
const at='2026-11-08T00:00:00.000Z',after=(hours:number)=>new Date(Date.parse(at)+hours*3600000).toISOString(),time=(now=at)=>({now,scenarioId:null,revision:0});
const node=(patch:Partial<JourneyNode>={}):JourneyNode=>({key:'sourcing_preparation',instanceId:'TEST-task',label:'原生任务',stage:'preparation',state:'active',round:1,occurrence:1,current:true,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:at,sla:'running',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,...patch});
const order=(nodes:JourneyNode[],asOf=at):OrderJourney=>{
 const item:OrderJourney={id:'TEST-mother',sourceId:null,orderId:'TEST-mother',designStyleNo:'TEST-style',temporaryStyleNo:null,customer:'TEST customer',category:'TEST category',designer:'TEST person',styleName:null,merchandisers:[],orderNumbers:[],createdAt:at,deliveryDate:null,selectedRound:null,adoptedRound:null,sourceVersion:null,instructionVersion:null,lines:[],links:[],asOf,stages:JOURNEY_STAGES.map(stage=>({...stage,state:'active',nodes:nodes.filter(node=>node.stage===stage.key)})),progress:{development:null,bulk:null},hitReasons:[]};
 item.display=journeyDisplay(item,asOf);return item;
};
const task=(state:JourneySelectionTask['state']='active'):JourneySelectionTask=>({id:'TEST-task',kind:'sourcing_preparation',sourceId:null,orderId:'TEST-mother',assigneeId:'TEST-native-assignee',requiredRole:'order_merchandiser',routeInstanceId:'TEST-route',routeVersion:1,policyVersion:1,enteredAt:at,dueAt:after(1),warningAt:null,deadlineMode:'duration',deadlineExclusive:false,state});
const empty={plan:null,original:null,facts:{}};
describe('minimal native Journey selection facts',()=>{
 it('shares the original exact duration equality, legacy/date exclusive equality and Beijing day risk boundaries',()=>{
  const base={state:'active' as const,dueAt:after(1),warningAt:after(.7)};
  expect(journeyTaskTimeRisks({...base,deadlineExclusive:false},after(1))).toEqual(['due_soon']);
  expect(journeyTaskTimeRisks(base,after(1))).toEqual(['overdue']);
  expect(journeyTaskTimeRisks({...base,deadlineExclusive:true},after(1))).toEqual(['overdue']);
  expect(journeyTaskTimeRisks({...base,state:'completed'},after(2))).toEqual([]);
  expect(journeyObservedDay('2026-11-08T15:59:59.999Z')).toBe('2026-11-08');expect(journeyObservedDay('2026-11-08T16:00:00.000Z')).toBe('2026-11-09');
  expect(journeyPlanDateOverdue('2026-11-08','2026-11-08')).toBe(false);expect(journeyPlanDateOverdue('2026-11-08','2026-11-09')).toBe(true);
 });
 it('keeps current native keys and raw assignments without copying DTOs, names, URLs or unexpected financial fields',()=>{
  const current=node({records:[{domain:'task',id:'TEST-task',url:'https://example.invalid/TEST-private-url',mode:'handle',version:1,lineId:null}]}),history=node({instanceId:'TEST-old',current:false}),item=order([current,history]);
  Object.assign(item,{budgetTotal:'TEST-private-money'});Object.assign(current,{price:'TEST-private-price'});const before=structuredClone(item);
  const {facts}=journeySelectionFacts(item,empty,[task()],time()),json=JSON.stringify(facts);
  expect(facts.nodes).toHaveLength(1);expect(facts.nodes[0]).toMatchObject({instanceId:'TEST-task',entered:true,recorded:true});
  expect(facts.tasks).toEqual([{id:'TEST-task',kind:'sourcing_preparation',sourceId:null,orderId:'TEST-mother',assigneeId:'TEST-native-assignee',requiredRole:'order_merchandiser'}]);
  for(const excluded of ['TEST-private-url','TEST-private-money','TEST-private-price','TEST person','TEST customer','TEST-old'])expect(json).not.toContain(excluded);
  expect(item).toEqual(before);
 });
 it('expires at a PO date becoming today, then its exclusive end, while terminal orders do not poll all future promise dates',()=>{
  const now='2026-11-08T15:59:59.999Z',item=order([node()],now);
  item.poDeliveryDates=[{lineId:'TEST-line',position:1,poNumber:'TEST PO',color:'黑',customerWarehouseArrivalDate:'2026-11-09',factoryDeliveryDate:null,sampleTargetDate:null}];
  expect(journeySelectionFacts(item,empty,[],time(now)).expiresAt).toBe('2026-11-08T16:00:00.000Z');
  const next='2026-11-08T16:00:00.000Z';item.asOf=next;
  expect(journeySelectionFacts(item,empty,[],time(next)).expiresAt).toBe('2026-11-09T16:00:00.000Z');
  const finished=order([node({key:'packing',stage:'receiving',state:'completed'})],now);finished.poDeliveryDates=item.poDeliveryDates;
  expect(journeySelectionFacts(finished,empty,[],time(now)).expiresAt).toBeNull();
 });
 it('retains an open original task deadline even when a linked document replaces its display state, without polling completed tasks',()=>{
  const item=order([node({state:'completed'})]);
  expect(journeySelectionFacts(item,empty,[task()],time()).expiresAt).toBe(new Date(Date.parse(after(1))+1).toISOString());
  expect(journeySelectionFacts(item,empty,[task('completed')],time()).expiresAt).toBeNull();
 });
 it('takes the next change from the canonical frozen engine and refuses a different observation snapshot',()=>{
  const plan:SlaPlan={warningPercent:70,stageBufferMinutes:0,anchors:{start:{precision:'instant',value:at,source:'TEST original start'}},nodes:[{id:'work',label:'原生工作',stage:1,parameterKey:'work',applicable:'yes',countsProgress:true,kind:'duration',minutes:60,offsetDays:null,dependsOn:[],anchorKey:'start',targetKey:null,includedIn:null,includedPosition:'start'}]};
  const item=order([node()]);expect(journeySelectionFacts(item,{plan,original:plan,facts:{work:{startedAt:at,evidence:'TEST native start'}}},[],time()).expiresAt).toBe(after(.7));
  expect(()=>journeySelectionFacts(item,empty,[],time(after(1)))).toThrow('same captured observation time');
 });
});

describe('compiled native Journey clock transitions',()=>{
 const delivery={finished:false,factoryFinished:false,sampleFinished:false,sentLineIds:[] as string[]};
 const frameAt=(frames:ReturnType<typeof compileJourneySelectionClock>['frames'],at:string)=>frames.filter(frame=>frame.from<=at).at(-1)!;
 it('reports a future trusted native event recheck without inventing its start/completion or polling permanently untrusted history',async()=>{
  const row={task_id:'TEST future task',task_kind:'development_pattern',state:'completed',entered_at:after(1),completed_at:after(2),entered_quality:'已核实',completed_quality:'已核实',returned:false,rejected:false};
  const db={query:vi.fn().mockResolvedValue({rows:[row]})} as unknown as PoolClient,rechecks:string[]=[];
  const early=await developmentNativeFacts(db,'TEST source',time(),at=>rechecks.push(at));
  expect(Object.values(early)[0]).toEqual({evidence:'task:TEST future task',businessCompleted:true});expect(rechecks).toEqual([after(1),after(2)]);
  rechecks.length=0;const later=await developmentNativeFacts(db,'TEST source',time(after(2)),at=>rechecks.push(at));
  expect(Object.values(later)[0]).toMatchObject({startedAt:after(1),completedAt:after(2)});expect(rechecks).toEqual([]);
  row.entered_quality=row.completed_quality='旧记录';await developmentNativeFacts(db,'TEST source',time(),at=>rechecks.push(at));expect(rechecks).toEqual([]);
 });
 it('matches canonical risk, coverage and PO reminders across exact warning/deadline/midnight boundaries without a midnight rebuild',()=>{
  const plan:SlaPlan={warningPercent:70,stageBufferMinutes:0,anchors:{start:{precision:'instant',value:at,source:'TEST start'}},nodes:[{id:'sourcing_preparation',label:'原生工作',stage:3,parameterKey:'work',applicable:'yes',countsProgress:true,kind:'duration',minutes:60,offsetDays:null,dependsOn:[],anchorKey:'start',targetKey:null,includedIn:null,includedPosition:'start'}]};
  const inputs={plan,original:plan,facts:{sourcing_preparation:{startedAt:at,evidence:'TEST native event'}}};
  const original=order([node({risks:['blocked'],state:'blocked'}),node({key:'packing',instanceId:'TEST-packing',stage:'receiving',state:'pending'})]);
  original.poDeliveryDates=[{lineId:'TEST-line',position:1,poNumber:'P1',color:'黑',customerWarehouseArrivalDate:'2026-11-09',factoryDeliveryDate:'2026-11-09',sampleTargetDate:'2026-11-09'}];
  original.lines=[{id:'TEST-line',color:'黑',po:'P1',formalStyleNo:null,temporaryStyleNo:null,quantity:'10'}];
  const item=structuredClone(original);
  attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,inputs.facts,time(),{mode:'read_projection'}),time(),{original:1,current:1},false,{facts:inputs.facts},new Set(['TEST-task']));
  const compiled=compileJourneySelectionClock(item,original,inputs,[task('blocked')],journeySelectionNodes(original.stages.flatMap(stage=>stage.nodes)),delivery,time());
  expect(compiled.expiresAt).toBeNull();expect(compiled.frames.length).toBeGreaterThan(3);
  for(const observed of [at,after(.7),after(1),new Date(Date.parse(after(1))+1).toISOString(),'2026-11-08T16:00:00.000Z','2026-11-09T16:00:00.000Z']){
   const expected=structuredClone(original),clock=time(observed);
   expected.stages.find(stage=>stage.key==='preparation')!.nodes[0]!.risks=[...journeyTaskTimeRisks(task('blocked'),observed),'blocked'];
   attachJourneySupervision(expected,plan,plan,evaluateSlaPlan(plan,inputs.facts,clock,{mode:'read_projection'}),clock,{original:1,current:1},false,{facts:inputs.facts},new Set(['TEST-task']));
   const frame=frameAt(compiled.frames,observed);
   expect(frame.risks).toEqual(expected.stages.flatMap(stage=>stage.nodes).map(node=>({id:node.instanceId,risks:node.risks})));
   expect(frame.coverage).toEqual(expected.supervision!.coverage);
   expect(frame.deliveryRisks).toEqual(poDeliveryRisks(expected.poDeliveryDates!,journeyObservedDay(observed),delivery).map(({nodeKey,risk,lineId})=>({nodeKey,risk,lineId})));
  }
 });
 it('rechecks a recorded future actual event instead of treating a future completion as an event created by time passage',()=>{
  const plan:SlaPlan={warningPercent:70,stageBufferMinutes:0,anchors:{start:{precision:'instant',value:at,source:'TEST start'}},nodes:[{id:'sourcing_preparation',label:'原生工作',stage:3,parameterKey:'work',applicable:'yes',countsProgress:true,kind:'duration',minutes:60,offsetDays:null,dependsOn:[],anchorKey:'start',targetKey:null,includedIn:null,includedPosition:'start'}]};
  const inputs={plan,original:plan,facts:{sourcing_preparation:{startedAt:at,completedAt:after(2),evidence:'TEST actual ahead of guarded observation'}}},original=order([node()]),item=structuredClone(original);
  attachJourneySupervision(item,plan,plan,evaluateSlaPlan(plan,inputs.facts,time(),{mode:'read_projection'}),time(),{original:1,current:1},false,{facts:inputs.facts});
  const compiled=compileJourneySelectionClock(item,original,inputs,[],journeySelectionNodes(original.stages.flatMap(stage=>stage.nodes)),delivery,time());
  expect(compiled.expiresAt).toBe(after(2));expect(compiled.frames.every(frame=>frame.from<after(2))).toBe(true);
  expect(compiled.frames[0]!.coverage.some(item=>item.key==='fact_time')).toBe(true);
  expect(original.stages.flatMap(stage=>stage.nodes)[0]!.state).toBe('active');
 });
});
