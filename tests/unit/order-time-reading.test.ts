import {SERIES_MILESTONE_OFFSETS} from '@dx-rework/contracts/digital-series-plan';
import {evaluateTimeFrameworkCandidate,freezeTimeFrameworkCandidate} from '../../apps/api/src/production-platform/order-time-framework.js';
import {orderTimeCompletionTarget} from '../../apps/api/src/production-platform/order-time-completion-target.js';
import {orderTimeCreatedMany} from '../../apps/api/src/production-platform/order-time-created.js';
import {describe,expect,it,vi} from 'vitest';
import {JOURNEY_STAGES,type JourneyNode,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import type {ScheduleOccurrence} from '@dx-rework/contracts';
import type {StoredOrderTimePlan} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {orderTimeReadingBasis,attachOrderTimeCoverage} from '../../apps/api/src/production-platform/order-time-reading.js';
import {evaluateOrderTimeScenario} from '../../apps/api/src/production-platform/order-time-schedule.js';
import {evaluateFixedJourneyBasis,attachFixedJourneySchedule,fixedScheduleBasisSnapshot,nextFixedScheduleClassification,type FixedScheduleBasis} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import {fixedScheduleStages} from '../../apps/api/src/production-platform/fixed-schedule-stages.js';
import {journeyVisualProgress} from '../../apps/api/src/production-platform/journey-visual-progress.js';
import {cockpitOwnStatus,cockpitTargetDifference} from '../../apps/web/src/cockpit-fixed-schedule.js';
import * as factoryTiming from '../../apps/api/src/production-platform/factory-batch-timing.js';
import {factorySlaEvidence} from '../../apps/api/src/production-platform/factory-sla-evidence.js';
import {factoryBatchLedger} from '../../apps/api/src/production-platform/factory-batch-ledger.js';

const at=(hour:number)=>new Date(Date.parse('2027-03-01T00:00:00.000Z')+hour*3600000).toISOString();
const point=(hour:number):ScheduleOccurrence=>({precision:'instant',at:at(hour)}),unknown:ScheduleOccurrence={precision:'unknown'};
const duration=(hours:number):OrderTimeRule=>({kind:'work',minutes:hours*60,calendar:'continuous',reminder:{enabled:true,percent:70}});
const resource={kind:'source' as const,id:'TEST-source'};
function item():OrderJourney{return {id:resource.id,sourceId:resource.id,orderId:null,designStyleNo:'TEST R506',temporaryStyleNo:null,customer:null,category:null,styleName:null,designer:null,merchandisers:[],orderNumbers:[],createdAt:at(0),deliveryDate:null,sourceVersion:1,instructionVersion:null,selectedRound:1,adoptedRound:null,lines:[],links:[],progress:{development:null,bulk:null},hitReasons:[],asOf:at(1),stages:JOURNEY_STAGES.map(stage=>({...stage,state:'uncreated',nodes:[]}))};}
function node(key:string,state:JourneyNode['state'],enteredAt:string|null,actualAt:string|null=null):JourneyNode{return {key,instanceId:key+':1',label:key,stage:'development',state,round:1,occurrence:null,current:true,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt,actualQuality:actualAt?'verified':'missing',enteredAt,sla:enteredAt?'running':'not_started',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null};}
function stored():StoredOrderTimePlan{
 const input:StoredOrderTimePlan['input']={version:'order-time-input-v1',plan:{version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'TEST original standard',revision:1,stageBufferMinutes:0,nodes:{a:duration(5),b:duration(4),future:duration(3)}}},
  route:{complete:true,missing:[]},work:[{id:'a',parameterKey:'a',stage:2,dependsOn:[]},{id:'b',parameterKey:'b',stage:2,dependsOn:['a']},{id:'future',parameterKey:'future',stage:2,dependsOn:[]}],
  scopes:[{scopeRef:'TEST scope',lineId:null,terminalIds:['b','future'],customerGoalIds:[],goals:{b:{precision:'instant',value:at(10),source:'TEST customer promise'},future:{precision:'instant',value:at(10),source:'TEST customer promise'}},customerGoal:{precision:'instant',value:at(10),source:'TEST customer promise'}}]};
 const evaluated=evaluateOrderTimeScenario({...input,start:{precision:'instant',value:at(0),source:'TEST assumption, not actual'}})[0]!;
 return {id:'TEST plan',resource,revision:1,input,targets:{'TEST scope':Object.fromEntries(evaluated.targets.map(target=>[target.id,target]))},identityHash:'TEST exact frozen input identity',time:{now:at(0),scenarioId:null,revision:0},actorId:'TEST actor',eventRef:'TEST approved original event',changeKind:'initial'};
}
const evidence=()=>({tasks:[],readiness:new Map(),cutting:[],cutCompletions:[]});
const build=(saved=stored(),row=item(),old:FixedScheduleBasis|null=null)=>orderTimeReadingBasis(saved,resource,row,{},evidence(),old);
describe('R5 exact frozen order-time reading and independent visible endpoints',()=>{
 it('retains completed deviation against the occurrence-time version while exposing the later current arrangement',()=>{
  const original=stored(),changed=structuredClone(original),row=item();
  original.targets['TEST scope']!.a!.end.at=at(6);original.time.now=at(0);
  changed.id='TEST changed';changed.revision=2;changed.time.now=at(9);changed.targets['TEST scope']!.a!.end.at=at(10);
  row.stages[1]!.nodes=[node('a','completed',at(5),at(7))];
  const policies=[changed,original].map(plan=>({id:plan.id,at:plan.time.now,plan:plan.input.plan,history:{input:plan.input,targets:plan.targets,revision:plan.revision,time:plan.time}}));
  const basis=orderTimeReadingBasis(changed,resource,row,{}, {...evidence(),policies},null);
  const projected=evaluateFixedJourneyBasis(fixedScheduleBasisSnapshot(basis),at(12),false),a=projected.scopes[0]!.nodes.find(n=>n.id==='a')!;
  expect(a.goalDelta).toMatchObject({kind:'late',signedValue:60,targetAt:at(6),targetRevision:'TEST plan:1'});
  expect(a.currentTarget).toMatchObject({at:at(10),revision:'TEST changed:2'});
  expect(basis.scopes[0]!.work.find(n=>n.id==='a')!.end).toBe(at(10));
  expect(a.ownSla.state).toBe('within');
  // Later registration cannot select the current plan for an earlier physical completion.
  row.stages[1]!.nodes[0]!.actualDate='2027-03-01';
  const ambiguous=orderTimeReadingBasis(changed,resource,row,{}, {...evidence(),policies},null);
  expect(evaluateFixedJourneyBasis(ambiguous,at(30),false).scopes[0]!.nodes.find(n=>n.id==='a')!.goalDelta.kind).toBe('unknown');
 });
 it('reads the completed node from its frozen forward plan, never the separate backward compatibility target',()=>{
  const original=stored();original.input.plan.company.nodes.a=duration(6);
  const frozen=freezeTimeFrameworkCandidate(evaluateTimeFrameworkCandidate({scopeRef:'TEST scope',route:'B',acceptedAt:{precision:'instant',value:at(0),source:'TEST actual acceptance'},customerDelivery:{date:'2027-03-02',source:'TEST customer date',revision:1},milestoneStandard:{reference:'TEST company',revision:1,offsets:SERIES_MILESTONE_OFFSETS.B},plan:original.input.plan,work:original.input.work,notBefore:{},bindings:Object.entries(SERIES_MILESTONE_OFFSETS.B).filter(([,offset])=>offset!==null).map(([key])=>({key:key as keyof typeof SERIES_MILESTONE_OFFSETS.B,workIds:['b']}))},{purpose:'order_proposal',observedAt:at(0)}),{reference:'TEST framework original',revision:1,previousReference:null,eventRef:'TEST approved'});
  original.input.frameworkPlans={'TEST scope':frozen};original.targets['TEST scope']!.a!.end.at=at(20);
  const changed=structuredClone(original);changed.id='TEST framework changed';changed.revision=2;changed.time.now=at(9);changed.input.frameworkPlans!['TEST scope']!.arranged.find(row=>row.id==='a')!.end.at=at(10);
  const policies=[changed,original].map(plan=>({id:plan.id,at:plan.time.now,plan:plan.input.plan,history:{input:plan.input,targets:plan.targets,revision:plan.revision,time:plan.time}}));
  const view=item();view.asOf=at(12);view.stages[1]!.nodes=[node('a','completed',at(5),at(7))];
  const read=orderTimeReadingBasis(changed,resource,view,{}, {...evidence(),policies},null),current=evaluateFixedJourneyBasis(read,at(12),false);
  expect(read.scopes[0]!.work.find(work=>work.id==='a')!.end).toBe(at(10));
  expect(current.scopes[0]!.nodes.find(work=>work.id==='a')!.goalDelta).toMatchObject({targetAt:at(6),signedValue:60});
  expect(current.framework?.scopes[0]?.milestones).toHaveLength(8);
  expect(fixedScheduleBasisSnapshot(read).framework).toEqual(read.framework);
  const result=orderTimeCompletionTarget(original.input.work[0]!,original.input.scopes[0]!,point(7),policies,null);
  expect(result).toMatchObject({end:at(6),targetRevision:'TEST plan:1',targetPrecision:'instant',targetDate:null});
  expect((Date.parse(at(7))-Date.parse(result!.end))/3600000).toBe(1);
  changed.input.frameworkPlans!['TEST scope']!.arranged=[];
  expect(orderTimeCompletionTarget(original.input.work[0]!,original.input.scopes[0]!,point(11),policies,null)).toBeNull();
 });
 it('retains pre-conversion source completion and original responsibility across formal PO scopes without borrowing another source or round',()=>{
  const original=stored(),later=structuredClone(original),formal=structuredClone(original),row=item();
  const canonical='source:TEST-source:round:1:node:a';
  original.input.work[0]!.canonicalWorkRef=canonical;original.targets['TEST scope']!.a!.end.at=at(6);
  later.input=structuredClone(original.input);later.id='TEST source later';later.revision=2;later.time.now=at(8);later.targets['TEST scope']!.a!.end.at=at(9);
  formal.resource={kind:'order',id:'TEST formal'};formal.id='TEST formal plan';formal.time.now=at(9);formal.input.plan.overrides.a=duration(1);
  formal.input.work=[{id:'source:a',parameterKey:'a',canonicalWorkRef:canonical,stage:2,dependsOn:[]}];
  formal.input.scopes=['red','blue'].map(lineId=>({scopeRef:'po:'+lineId,lineId,terminalIds:['source:a'],customerGoalIds:['source:a'],customerGoal:{precision:'instant',value:at(10),source:'TEST formal goal'},goals:{'source:a':{precision:'instant',value:at(10),source:'TEST formal goal'}}}));
  formal.targets=Object.fromEntries(formal.input.scopes.map(scope=>[scope.scopeRef,{'source:a':{...original.targets['TEST scope']!.a!,id:'source:a',end:{...original.targets['TEST scope']!.a!.end,at:at(10)}}}]));
  row.orderId=formal.resource.id;row.adoptedRound=1;
  const version=(v:StoredOrderTimePlan)=>({id:v.id,at:v.time.now,plan:v.input.plan,history:{input:v.input,targets:v.targets,revision:v.revision,time:v.time}});
  const inheritedPolicies={sourceId:resource.id,versions:[version(later),version(original)]};
  const proof={...evidence(),policies:[version(formal)],inheritedPolicies};
  const native={'source:a':{evidence:'TEST exact original round',startedAt:at(5),completedAt:at(7),businessCompleted:true}};
  const read=(p=proof)=>orderTimeReadingBasis(formal,formal.resource,row,native,p,null);
  for(const scope of evaluateFixedJourneyBasis(read(),at(12),false).scopes){
   expect(scope.nodes[0]!.goalDelta).toMatchObject({kind:'late',signedValue:60,targetAt:at(6),targetRevision:original.id+':1'});
   expect(scope.nodes[0]!.currentTarget?.at).toBe(at(10));expect(scope.nodes[0]!.ownSla.state).toBe('within');
  }
  expect(read().scopes[0]!.work[0]!.responsibilityMinutes).toBe(300);
  const work=formal.input.work[0]!,scope=formal.input.scopes[0]!;
  for(const bad of [{...inheritedPolicies,sourceId:'OTHER'}, {...inheritedPolicies,versions:[]}, {...inheritedPolicies,versions:[version({...original,time:{...original.time,scenarioId:'OTHER'}})]}])expect(orderTimeCompletionTarget(work,scope,point(7),proof.policies,null,bad)).toBeNull();
  expect(orderTimeCompletionTarget({...work,canonicalWorkRef:canonical.replace('round:1','round:2')},scope,point(7),proof.policies,null,inheritedPolicies)).toBeNull();
  expect(orderTimeCompletionTarget({...work,parameterKey:'b'},scope,point(7),proof.policies,null,inheritedPolicies)).toBeNull();
  expect(orderTimeCompletionTarget(work,scope,{precision:'date',date:'2027-03-01'},proof.policies,null,inheritedPolicies)).toBeNull();
  // Once the formal plan is effective its own PO target wins, never a later source edit.
  expect(orderTimeCompletionTarget(work,scope,point(11),proof.policies,null,inheritedPolicies)).toMatchObject({end:at(10),targetRevision:formal.id+':1'});
  expect(orderTimeCompletionTarget(work,{scopeRef:'po:unrelated',lineId:'unrelated'},point(11),proof.policies,null,inheritedPolicies)).toBeNull();
 });
 it('uses a verified native completion when the matching old plan has only an empty placeholder, without replacing recorded history',()=>{
  const row=item(),saved=stored(),legacy=build(saved,row);row.stages[1]!.nodes=[node('a','completed',at(0),at(2))];
  const native={a:{evidence:'TEST original policy without occurrence'}};
  const current=orderTimeReadingBasis(saved,resource,row,native,evidence(),legacy);
  expect(current.scopes[0]!.facts.a).toMatchObject({businessCompleted:true,completed:point(2)});
  const recorded=structuredClone(legacy);recorded.scopes[0]!.facts.a={...recorded.scopes[0]!.facts.a!,businessCompleted:true,completed:point(1),evidenceRefs:['TEST retained older valid event']};
  expect(orderTimeReadingBasis(saved,resource,row,native,evidence(),recorded).scopes[0]!.facts.a!.completed).toEqual(point(1));
  row.stages[1]!.nodes[0]!.actualQuality='missing';
  expect(orderTimeReadingBasis(saved,resource,row,native,evidence(),legacy).scopes[0]!.facts.a!.completed).toEqual(unknown);
 });

 it('uses the confirmed policy at original readiness for non-task work, retaining it after a later arrangement',()=>{
  const saved=stored(),row=item();row.stages[1]!.nodes=[node('a','active',at(2))];
  const earlier=structuredClone(saved.input.plan);earlier.overrides.a=duration(2);
  saved.input.plan.overrides.a=duration(1);
  const basis=orderTimeReadingBasis(saved,resource,row,{}, {...evidence(),policies:[{id:'TEST later',at:at(3),plan:saved.input.plan},{id:'TEST original',at:at(1),plan:earlier}]},null);
  const result=evaluateFixedJourneyBasis(basis,at(4.5),false).scopes[0]!.nodes.find(node=>node.id==='a')!;
  expect(result.ownSla).toMatchObject({state:'overdue',overdueMinutes:{minimum:30,maximum:30},warningAt:at(3.4)});
  expect(basis.scopes[0]!.work.find(work=>work.id==='a')?.responsibilityMinutes).toBe(120);
 });
 it('carries the original batch calendar through native evidence so an excluded Sunday is not charged as overdue work',async()=>{
  const start='2027-01-09T14:30:00.000Z',deadline='2027-01-09T15:30:00.000Z',observed='2027-01-10T16:30:00.000Z',window={key:'TEST native batch',kind:'warehouse_dispatch' as const,parameterKey:'warehouse_dispatch',enteredAt:start,dueAt:deadline,warningAt:'2027-01-09T15:12:00.000Z',completedAt:null,complete:false,evidence:'TEST original batch receipt/contract',minutes:60,calendarRef:'beijing_sunday_excluded' as const,lineId:'TEST-po'};
  const read=vi.spyOn(factoryTiming,'factoryBatchTiming').mockResolvedValue({routeSchemaVersion:1,preparationId:'TEST prep',snapshotId:'TEST frozen',warningRatio:.7,windows:[window],ledger:factoryBatchLedger([{lineId:'TEST-po',quantity:10}],[],[],true),stepLedger:null});
  try{
   const native=await factorySlaEvidence({query:async()=>({rows:[{secondary_craft:'无'}]})} as never,'TEST-order');expect(native?.facts.warehouse_dispatch!.batchWindows?.[0]?.calendarRef).toBe('beijing_sunday_excluded');
   const saved=stored(),row={...item(),id:'TEST-order',orderId:'TEST-order',sourceId:null},scope=saved.input.scopes[0]!;saved.resource={kind:'order',id:'TEST-order'};
   saved.input.plan.company.nodes={warehouse_dispatch:duration(1)};saved.input.work=[{id:'warehouse_dispatch',parameterKey:'warehouse_dispatch',stage:5,dependsOn:[]}];scope.scopeRef='po:TEST-po';scope.lineId='TEST-po';scope.terminalIds=['warehouse_dispatch'];scope.customerGoalIds=['warehouse_dispatch'];scope.customerGoal={precision:'instant',value:'2027-01-12T00:00:00.000Z',source:'TEST unchanged customer commitment'};scope.goals={warehouse_dispatch:scope.customerGoal};
   const computed=evaluateOrderTimeScenario({...saved.input,start:{precision:'instant',value:start,source:'TEST planning assumption'}})[0]!;saved.targets={[scope.scopeRef]:Object.fromEntries(computed.targets.map(target=>[target.id,target]))};
   const basis=orderTimeReadingBasis(saved,saved.resource,row,native!.facts,evidence(),null),result=evaluateFixedJourneyBasis(basis,observed,false);
   expect(result.scopes[0]!.nodes[0]!.ownSla).toMatchObject({state:'overdue',overdueMinutes:{minimum:60,maximum:60}});
  }finally{read.mockRestore();}
 });
 it('reads accurate targets before production preparation and uses a known start without requiring future branch entries',()=>{
  const row=item();row.stages[1]!.nodes=[node('a','active',at(0)),node('b','uncreated',null),node('future','pending',null)];
  const basis=build(stored(),row),result=evaluateFixedJourneyBasis(basis,at(1),false);
  expect(basis.scopes[0]!.work.map(work=>[work.id,work.start,work.end])).toEqual([['a',at(1),at(6)],['b',at(6),at(10)],['future',at(7),at(10)]]);
  expect(result.durationSummary).toMatchObject({planStart:at(1),planEnd:at(10),planSpanMinutes:540,actualStart:point(0),elapsedSpanMinutes:{minimum:60,maximum:60},finalActualSpanMinutes:null});
  expect(result.scopes[0]!.nodes.find(work=>work.id==='a')!.ownSla.state).toBe('not_adopted');
  // A read may not apply today's standard to a historical begun window.
  expect(basis.scopes[0]!.facts.future).toMatchObject({notYetReady:true,ready:unknown,completed:unknown});
 });
 it('keeps genuinely missing historical starts unknown rather than borrowing a downstream completion or creation time',()=>{
  const row=item();row.stages[1]!.nodes=[node('a','completed',null,at(2)),node('b','active',at(2)),node('future','pending',null)];
  const result=evaluateFixedJourneyBasis(build(stored(),row),at(5),false);
  expect(result.durationSummary.actualStart).toEqual(unknown);expect(result.durationSummary.elapsedSpanMinutes).toBeNull();
  expect(result.scopes[0]!.nodes.find(work=>work.id==='a')!.goalDelta).toMatchObject({kind:'early',signedValue:-240});
 });
 it('keeps the original begun responsibility quota and reminder while a new arrangement changes planning duration',()=>{
  const row=item();row.stages[1]!.nodes=[node('a','active',at(0)),node('b','pending',null),node('future','pending',null)];
  const original=build(stored(),row),work=original.scopes[0]!.work.find(work=>work.id==='a')!;
  work.responsibilitySlaRef='TEST original5hour window';work.responsibilityMinutes=300;work.responsibilityCalendar='continuous';work.responsibilityWarningAt=at(3.5);
  const changed=stored();changed.input.plan.overrides.a=duration(1);changed.input.plan.revision=2;
  const basis=build(changed,row,original),before=evaluateFixedJourneyBasis(basis,at(4),false),after=evaluateFixedJourneyBasis(basis,at(6),false);
  expect(before.scopes[0]!.nodes.find(node=>node.id==='a')!.ownSla).toMatchObject({state:'within',warning:true,warningAt:at(3.5)});
  expect(after.scopes[0]!.nodes.find(node=>node.id==='a')!.ownSla).toMatchObject({state:'overdue',overdueMinutes:{minimum:60,maximum:60}});
  expect(basis.scopes[0]!.work.find(work=>work.id==='a')!.end).toBe(at(6));
  expect(nextFixedScheduleClassification(basis,at(3))).toBe(at(3.5));
 });
 it('does not turn future unperformed actuals into missing-time KPI, but reports route/settings and completed actual gaps',()=>{
  const row=item();row.supervision={asOf:at(1),status:'legacy_unenrolled',originalRevision:null,currentRevision:null,nodes:[],coverage:[{key:'plan',message:'TEST no old plan'}],customerReminderDate:null};
  row.stages[1]!.nodes=[node('a','uncreated',null),node('b','pending',null),node('future','pending',null)];
  const basis=build(stored(),row);attachOrderTimeCoverage(row,basis);expect(row.supervision.coverage).toEqual([]);
  basis.scopes[0]!.facts.a!.businessCompleted=true;attachOrderTimeCoverage(row,basis);expect(row.supervision.coverage.map(c=>c.key)).toEqual(['fact_time']);
  basis.pending=true;attachOrderTimeCoverage(row,basis);expect(row.supervision.coverage.map(c=>c.key).sort()).toEqual(['fact_time','plan']);
 });
 it('retains a future own-window transition when an excluded Sunday follows a native deadline',()=>{
  const basis=build(),scope=basis.scopes[0]!;scope.work=[{...scope.work[0]!,dependsOn:[],start:at(0),end:at(500)}];scope.terminalIds=['a'];scope.customerGoal=at(500);
  scope.facts={a:{ready:point(112),clockStart:point(112),completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:[],ownWindows:[{sourceRef:'TEST original native Sunday boundary',started:point(112),completed:unknown,complete:false,deadline:at(136),warningAt:null,calendar:'beijing_sunday_excluded'}]}};
  expect(nextFixedScheduleClassification(basis,at(137))).toBe(new Date(Date.parse(at(160))+1).toISOString());
  expect(evaluateFixedJourneyBasis(basis,at(137),false).scopes[0]!.nodes[0]!.ownSla.state).toBe('within');
  expect(evaluateFixedJourneyBasis(basis,new Date(Date.parse(at(160))+1).toISOString(),false).scopes[0]!.nodes[0]!.ownSla.state).toBe('overdue');
  scope.facts.a!.ownWindows![0]!.calendar=null;
  expect(()=>nextFixedScheduleClassification(basis,at(137))).not.toThrow();
  expect(evaluateFixedJourneyBasis(basis,at(137),false).scopes[0]!.nodes[0]!.ownSla.state).toBe('unknown');
 });
 it('matches a frozen historical round exactly and never borrows current-round native aggregation',()=>{
  const saved=stored(),row=item();row.selectedRound=2;saved.input.work[0]!.canonicalWorkRef='source:TEST-source:round:1:work:a';
  row.stages[1]!.nodes=[{...node('a','completed',at(8),at(9)),round:2}];
  const result=orderTimeReadingBasis(saved,resource,row,{a:{evidence:'TEST round2 completion',startedAt:at(8),completedAt:at(9),businessCompleted:true}},evidence(),null);
  expect(result.scopes[0]!.facts.a).toMatchObject({ready:unknown,completed:unknown,businessCompleted:false});
 });
 it('uses each real PO cutting gate and completion instead of spreading the whole-task start or another PO result',()=>{
  const saved=stored(),order={kind:'order' as const,id:'TEST-order'},row={...item(),orderId:order.id,sourceId:null,selectedRound:null};saved.resource=order;
  saved.input.plan.company.nodes.bulk_cutting=duration(24);saved.input.work=[{id:'bulk_cutting',parameterKey:'bulk_cutting',stage:4,dependsOn:[]}];
  saved.input.scopes=['A','B'].map(lineId=>({scopeRef:'po:'+lineId,lineId,terminalIds:['bulk_cutting'],customerGoalIds:['bulk_cutting'],customerGoal:{precision:'instant',value:at(48),source:'TEST real PO promise'},goals:{bulk_cutting:{precision:'instant',value:at(48),source:'TEST real PO promise'}}}));
  saved.targets=Object.fromEntries(evaluateOrderTimeScenario({...saved.input,start:{precision:'instant',value:at(0),source:'TEST assumption'}}).map(scope=>[scope.scopeRef,Object.fromEntries(scope.targets.map(target=>[target.id,target]))]));
  const proof:Parameters<typeof orderTimeReadingBasis>[4]={tasks:[{task_id:'TEST cut',task_kind:'bulk_cutting_external',source_id:null,production_order_id:order.id,route_version:1,state:'active',entered_at:new Date(at(0)),entered_quality:'已核实',completed_at:null,completed_quality:'未登记',step_id:null,returned:false,rejected:false,sla_basis:{seconds:86400,calendarRef:'continuous'},native_entered_at:new Date(at(0)),warning_at:null}],
   readiness:new Map([['TEST cut',{taskId:'TEST cut',tracked:true,eventId:'TEST task ready',effectiveEventId:'TEST task ready',firstReadyAt:at(0),quality:'已核实',scopeRef:'TEST whole task',basis:[]}]]),
   cutting:[{taskId:'TEST cut',tracked:true,eventId:'TEST A gate',effectiveEventId:'TEST A gate',firstReadyAt:at(2),quality:'已核实',scopeRef:'po:A:cut:A',lineId:'A',cuttingOrderId:'TEST cut A',basis:['TEST A physical materials']}],
   cutCompletions:[{event_id:'TEST A real actual',occurred_at:new Date(at(5)),time_quality:'已核实',payload:{lineId:'A',cuttingOrderId:'TEST cut A'}}]};
  let result=orderTimeReadingBasis(saved,order,row,{},proof,null);
  expect(result.scopes[0]!.facts.bulk_cutting).toMatchObject({ready:point(2),completed:point(5),businessCompleted:true});
  expect(result.scopes[1]!.facts.bulk_cutting).toMatchObject({ready:unknown,completed:unknown,businessCompleted:false,notYetReady:true});
  const completed=proof.cutCompletions;proof.cutCompletions=[];
  const unfinished=orderTimeReadingBasis(saved,order,row,{},proof,null),observed=evaluateFixedJourneyBasis(unfinished,at(25),false);
  expect(unfinished.scopes[0]!.facts.bulk_cutting!.clockStart).toEqual(point(2));expect(unfinished.scopes[1]!.facts.bulk_cutting!.clockStart).toEqual(unknown);
  expect(observed.scopes[0]!.nodes[0]!.ownSla).toMatchObject({state:'within',overdueMinutes:{minimum:0,maximum:0}});expect(observed.scopes[1]!.nodes[0]!.ownSla.state).not.toBe('overdue');
  proof.tasks[0]!.task_kind='bulk_cutting';const internal=orderTimeReadingBasis(saved,order,row,{},proof,null);expect(internal.scopes[0]!.facts.bulk_cutting!.clockStart).toEqual(point(2));expect(internal.scopes[1]!.facts.bulk_cutting!.clockStart).toEqual(unknown);
  const corrected=structuredClone(unfinished);corrected.scopes[0]!.facts.bulk_cutting!.clockStart=point(3);corrected.scopes[0]!.facts.bulk_cutting!.evidenceRefs.push('TEST precise corrected PO clock');expect(orderTimeReadingBasis(saved,order,row,{},proof,corrected).scopes[0]!.facts.bulk_cutting!.clockStart).toEqual(point(3));
  proof.tasks[0]!.task_kind='bulk_cutting_external';proof.cutCompletions=completed;
  proof.cutting=[];proof.readiness.get('TEST cut')!.tracked=false;result=orderTimeReadingBasis(saved,order,row,{},proof,null);
  expect(result.scopes[0]!.facts.bulk_cutting).toMatchObject({ready:unknown,completed:point(5),businessCompleted:true,notYetReady:false});
 });
 it.each(['printing','embroidery'])('closes a stored %s parent only on its exact included return, without a legacy basis',craft=>{
  const saved=stored(),parent='development_'+craft,other='development_'+(craft==='printing'?'embroidery':'printing');
  saved.input.plan.company.nodes={[parent]:duration(6),[other]:duration(6),development_craft_return:{kind:'included',minutes:30,calendar:'continuous',reminder:{enabled:false,percent:70}}};
  saved.input.work=[{id:parent,parameterKey:parent,stage:2,dependsOn:[],canonicalWorkRef:'source:TEST-source:round:1:step:TEST-own:work'},
   {id:'own-return',parameterKey:'development_craft_return',stage:2,dependsOn:[],includedIn:parent,includedPosition:'end',canonicalWorkRef:'source:TEST-source:round:1:step:TEST-own:return'},
   {id:other,parameterKey:other,stage:2,dependsOn:[]},{id:'other-return',parameterKey:'development_craft_return',stage:2,dependsOn:[],includedIn:other,includedPosition:'end',canonicalWorkRef:'source:TEST-source:round:1:step:TEST-other:return'}];
  saved.input.scopes=[{...saved.input.scopes[0]!,terminalIds:[parent,other],goals:{[parent]:{precision:'instant',value:at(10),source:'TEST real promise'},[other]:{precision:'instant',value:at(10),source:'TEST real promise'}}}];
  saved.targets=Object.fromEntries(evaluateOrderTimeScenario({...saved.input,start:{precision:'instant',value:at(0),source:'TEST planning assumption'}}).map(scope=>[scope.scopeRef,Object.fromEntries(scope.targets.map(target=>[target.id,target]))]));
  const task=(id:string,kind:string,step:string,state:string,completed:number|null):Parameters<typeof orderTimeReadingBasis>[4]['tasks'][number]=>({task_id:id,task_kind:kind,source_id:resource.id,production_order_id:null,route_version:1,state,entered_at:new Date(at(0)),entered_quality:'已核实',completed_at:completed===null?null:new Date(at(completed)),completed_quality:completed===null?'未登记':'已核实',step_id:step,returned:false,rejected:false,sla_basis:{seconds:21600,calendarRef:'continuous'},native_entered_at:new Date(at(0)),warning_at:null});
  const proof:Parameters<typeof orderTimeReadingBasis>[4]={...evidence(),tasks:[task('TEST processing',parent,'TEST-own','completed',2),task('TEST own receipt','development_craft_confirmation','TEST-own','active',null),task('TEST other receipt','development_craft_confirmation','TEST-other','completed',3)]};
  const read=()=>orderTimeReadingBasis(saved,resource,item(),{[parent]:{evidence:'task:TEST processing;task:TEST own receipt',startedAt:at(0),businessCompleted:false}},proof,null).scopes[0]!.facts[parent]!;
  expect(read()).toMatchObject({businessCompleted:false,completed:unknown});
  proof.tasks[1]!.state='completed';proof.tasks[1]!.completed_at=new Date(at(5));proof.tasks[1]!.completed_quality='已核实';
  expect(read()).toMatchObject({businessCompleted:true,completed:point(5)});expect(read().completed).not.toEqual(point(2));expect(read().completed).not.toEqual(point(3));
  proof.tasks[1]!.completed_quality='未登记';expect(read()).toMatchObject({businessCompleted:true,completed:unknown});
  proof.tasks[1]!.route_version=2;expect(read()).toMatchObject({businessCompleted:false,completed:unknown});
 });
 it('uses the stage endpoint for its own date difference rather than an earlier child target',()=>{
  const basis=build(),scope=basis.scopes[0]!;scope.work=scope.work.filter(work=>work.id!=='future').map((work,index)=>({...work,dependsOn:[],start:at(0),end:at(index?12*24:2*24),stage:4}));scope.terminalIds=['a','b'];
  scope.facts={a:{ready:point(0),clockStart:point(0),completed:point(17*24+12),businessCompleted:true,waitingForPredecessors:false,evidenceRefs:[]},b:{ready:point(0),clockStart:point(0),completed:point(17*24+12),businessCompleted:true,waitingForPredecessors:false,evidenceRefs:[]}};
  const result=fixedScheduleStages(basis,at(20*24))[0]!;
  expect(result.expected).toEqual(point(12*24));expect(result.actual).toEqual(point(17*24+12));expect(result.goalDelta.signedValue).toBe((5*24+12)*60);
  expect(result.goalDelta.signedValue).not.toBe((15*24+12)*60);
 });
 it('keeps the whole reliable start independent from unrelated missing UI milestones and returns no fake actual finish',()=>{
  const row=item();row.stages[1]!.nodes=[node('a','active',at(0)),node('b','uncreated',null),node('future','pending',null)];
  attachFixedJourneySchedule(row,build(stored(),row),at(1));const visual=journeyVisualProgress(row,at(1));
  expect(visual.startedAt).toBe(at(0));expect(visual.timeRatio).toBeNull();expect(visual.actual.at).toBeNull();
  expect(visual.expected.at).toBe(at(10)); // Frozen work target remains readable, not a customer date.
  row.lines=[{id:'TEST delivery PO',po:'TEST-PO',color:'黑',formalStyleNo:null,temporaryStyleNo:null,orderedQuantity:1}];
  row.poDeliveryDates=[{lineId:'TEST delivery PO',customerWarehouseArrivalDate:'2027-03-01'} as NonNullable<OrderJourney['poDeliveryDates']>[number]];
  // 08:00 Beijing start, 09:00 observation, next midnight deadline: 1/16.
  expect(journeyVisualProgress(row,at(1))).toMatchObject({startedAt:at(0),timeRatio:1/16,actual:{at:null}});
 });
 it('preserves the completed own late result even when its fixed target is early, with normal target zero shown as green minus-zero',()=>{
  const row=item();row.stages[1]!.nodes=[node('a','completed',at(0),at(2))];const basis=build(stored(),row),work=basis.scopes[0]!.work.find(work=>work.id==='a')!;
  work.responsibilitySlaRef='TEST native1h';work.responsibilityMinutes=60;work.responsibilityCalendar='continuous';
  attachFixedJourneySchedule(row,basis,at(3));expect(cockpitOwnStatus(row.stages[1]!.nodes[0]!)).toEqual({text:'逾期（有责口径）',tone:'danger'});
  const current=row.stages[1]!.nodes[0]!.fixedTargets![0]!.progress;current.businessCompleted=false;current.goalDelta={...current.goalDelta,kind:'on_target',signedValue:0};
  expect(cockpitTargetDifference(row.stages[1]!.nodes,at(3))).toMatchObject({text:'-0',tone:'success'});
 });
 it('rates original batches separately without resetting the first D or charging the gap between completed batches',()=>{
  const basis=build(),scope=basis.scopes[0]!,fact=scope.facts.a!;
  fact.ready=point(0);fact.clockStart=point(0);fact.ownWindows=[
   {sourceRef:'TEST first original window',started:point(0),completed:point(25),complete:true,deadline:at(24),warningAt:at(16),calendar:'continuous'},
   {sourceRef:'TEST second original window',started:point(48),completed:unknown,complete:false,deadline:at(72),warningAt:at(64),calendar:'continuous'}];
  const own=(time:number)=>evaluateFixedJourneyBasis(basis,at(time),false).scopes[0]!.nodes.find(node=>node.id==='a')!.ownSla;
  expect(own(50)).toMatchObject({state:'overdue',overdueMinutes:{minimum:60,maximum:60}});
  fact.ownWindows=[{...fact.ownWindows[0]!,complete:false,completed:unknown},fact.ownWindows[1]!];
  expect(own(50)).toMatchObject({state:'overdue',overdueMinutes:{minimum:26*60,maximum:26*60}});
  fact.ownWindows=[{...fact.ownWindows[0]!,complete:true,completed:point(20)},{...fact.ownWindows[1]!,complete:true,completed:point(52)}];
  expect(own(80)).toMatchObject({state:'within',overdueMinutes:{minimum:0,maximum:0}});
  fact.ownWindows=[{...fact.ownWindows[0]!,completed:unknown},fact.ownWindows[1]!];
  expect(own(80)).toMatchObject({state:'unknown',overdueMinutes:null});
 });
 it('keeps real added native redo in the handoff dependency instead of dropping it when reading the stored initial route',()=>{
  const saved=stored(),old=build(saved),scope=old.scopes[0]!,handoff=scope.work.find(work=>work.id==='b')!;
  scope.work=[...scope.work,{id:'TEST redo',canonicalWorkRef:'rework:TEST real redo',stage:2,dependsOn:['a'],start:at(6),end:at(6),minutes:60,calendar:'continuous',accountingRole:'added_work',originalHandoffAt:at(6),responsibilitySlaRef:'TEST original redo window',responsibilityMinutes:60,responsibilityCalendar:'continuous'}];
  handoff.dependsOn=[...handoff.dependsOn,'TEST redo'];scope.facts['TEST redo']={ready:point(3),clockStart:point(3),completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:['TEST actual approved redo'],impactStartedAt:at(3)};
  const result=build(saved,item(),old).scopes[0]!;
  expect(result.work.find(work=>work.id==='b')!.dependsOn).toContain('TEST redo');expect(result.work.find(work=>work.id==='TEST redo')).toMatchObject({originalHandoffAt:at(6),accountingRole:'added_work'});
  expect(evaluateFixedJourneyBasis({...old,scopes:[result]},at(5),false).scopes[0]!.nodes.find(node=>node.id==='TEST redo')!.ownSla).toMatchObject({state:'overdue',overdueMinutes:{minimum:60,maximum:60}});
 });
 it('whitelists exact policy/stage/reminder facts without carrying company settings, roles or display DTO into shared storage',()=>{
  const basis=build();Object.assign(basis,{company:{TESTsecret:true},actorRoles:['TEST root']});basis.scopes[0]!.work[0]!.responsibilityReminderPercent=70;
  const saved=fixedScheduleBasisSnapshot(basis);expect(saved.policyVersion).toBe('order-time-plan-v1');expect(saved.scopes[0]!.work[0]).toMatchObject({stage:2,responsibilityReminderPercent:70});
  expect(JSON.stringify(saved)).not.toContain('TESTsecret');expect(JSON.stringify(saved)).not.toContain('actorRoles');
 });
});

describe('native creation metadata batch',()=>{
 it('keeps a trustworthy creation date while isolating an invalid or missing subject in one batch',async()=>{
  const query=vi.fn().mockResolvedValue({rows:[
   {resource_kind:'source',resource_id:'a',created_business_time:{now:'2026-11-20T00:00:00.000Z',scenarioId:null,revision:0},creation_event_ref:'TEST actual creation'},
   {resource_kind:'order',resource_id:'b',created_business_time:{now:'invalid',scenarioId:null,revision:0},creation_event_ref:'TEST invalid input'},
   {resource_kind:'order',resource_id:'legacy',created_business_time:null,creation_event_ref:null,legacy_adopted:true},
   {resource_kind:'order',resource_id:'missing-new',created_business_time:null,creation_event_ref:null,legacy_adopted:false},
  ]});
  const result=await orderTimeCreatedMany({query} as never,[{kind:'source',id:'a'},{kind:'order',id:'b'},{kind:'source',id:'missing'},{kind:'source',id:'a'},{kind:'order',id:'legacy'},{kind:'order',id:'missing-new'}]);
  expect(query).toHaveBeenCalledTimes(1);expect(result.get('source:a')).toEqual({at:'2026-11-20T00:00:00.000Z',evidence:'TEST actual creation'});expect(result.get('order:b')).toBeNull();expect(result.get('source:missing')).toBeNull();expect(result.get('order:legacy')).toEqual({at:null,legacy:true});expect(result.get('order:missing-new')).toBeNull();
 });
});

describe('Acceptance PR02 route and per-PO responsibility projection',()=>{
 it('clears only never-started legacy craft unknowns for an explicitly complete no-craft order route',()=>{
  const row=item(),saved=stored(),resource={kind:'order' as const,id:'TEST-order'};
  row.orderId=resource.id;row.stages[4]!.nodes=[node('process_logistics','pending',null),node('bulk_qc','pending',null)];
  for(const n of row.stages[4]!.nodes){n.risks=['unknown'];n.progressApplicability='unknown';}
  const input=orderTimeReadingBasis(saved,resource,row,{},evidence(),null);
  expect(input.notApplicableNodes).toEqual(['process_logistics','bulk_qc']);
  attachFixedJourneySchedule(row,input,at(2));
  for(const n of row.stages[4]!.nodes)expect(n).toMatchObject({state:'not_applicable',risks:[],countsInProgress:false,progressApplicability:'not_applicable'});
  expect(fixedScheduleBasisSnapshot(input).notApplicableNodes).toEqual(input.notApplicableNodes);
  saved.input.route.complete=false;
  expect(orderTimeReadingBasis(saved,resource,row,{},evidence(),null).notApplicableNodes).toBeUndefined();
  const history=node('bulk_qc','completed',at(0),at(1));row.stages[4]!.nodes=[history];
  attachFixedJourneySchedule(row,input,at(2));expect(history.state).toBe('completed');expect(history.actualAt).toBe(at(1));
  const started=node('bulk_qc','pending',null);started.risks=['unknown'];started.nativeWindows=[{evidence:'TEST started native batch',scopeLabel:'TEST PO',startedAt:at(0),deadline:at(5),warningAt:null,completedAt:null,complete:false}];row.stages[4]!.nodes=[started];attachFixedJourneySchedule(row,input,at(2));expect(started.state).toBe('pending');expect(started.risks).toEqual(['unknown']);
 });
 it('retains known PO overdue alongside an unready PO and exposes independent deadlines, without changing whole-order delivery state',()=>{
  const row=item(),saved=stored();row.stages[1]!.nodes=[node('a','active',at(0))];row.stages[1]!.nodes[0]!.risks=['unknown'];
  const input=build(saved,row),first=input.scopes[0]!;
  first.work=first.work.filter(w=>w.id==='a').map(w=>({...w,minutes:1440,responsibilityMinutes:1440,responsibilitySlaRef:'TEST original 24h',responsibilityCalendar:'continuous' as const}));first.terminalIds=['a'];first.customerGoal=at(100);
  first.facts={a:{ready:point(2),clockStart:point(2),completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:['TEST PO A R02']}};
  const second=structuredClone(first);second.scopeRef='TEST PO B';second.lineId='TEST B';second.facts.a={ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:true,notYetReady:true,evidenceRefs:['TEST PO B not ready']};
  first.lineId='TEST A';input.scopes=[first,second];
  let progress=evaluateFixedJourneyBasis(input,at(25),false);
  expect(progress.scopes[0]!.nodes[0]!.ownSla).toMatchObject({state:'within',deadlineAt:at(26)});
  expect(progress.scopes[1]!.nodes[0]!.ownSla).toMatchObject({state:'unknown',deadlineAt:null});
  attachFixedJourneySchedule(row,input,at(27));progress=row.fixedSchedule!;
  expect(row.stages[1]!.nodes[0]!.risks).toEqual(['unknown','overdue']);
  expect(progress.scopes.map(s=>s.customerDuePassed)).toEqual([false,false]);
  expect(progress.scopes[0]!.nodes[0]!.ownSla).toMatchObject({state:'overdue',deadlineAt:at(26),overdueMinutes:{minimum:60,maximum:60}});
 });
});

it('attaches only the owning task, not another work whose readiness cites that task',()=>{
 const row=item(),cut=node('development_cutting','completed',at(1),at(2)),sew=node('development_sewing','completed',at(2),at(3));
 cut.instanceId='TEST-cut-task';sew.instanceId='TEST-sew-task';row.stages[1]!.nodes=[cut,sew];
 const basis=build(),scope=basis.scopes[0]!;
 scope.work=[{...scope.work[0]!,id:'source:development_cutting',canonicalWorkRef:'source:TEST:round:1:work:development_cutting'},{...scope.work[0]!,id:'source:development_sewing',canonicalWorkRef:'source:TEST:round:1:work:development_sewing'}];scope.terminalIds=scope.work.map(w=>w.id);
 scope.facts=Object.fromEntries(scope.work.map((w,i)=>[w.id,{ready:point(1),clockStart:point(1),completed:point(i+2),businessCompleted:true,waitingForPredecessors:false,evidenceRefs:[`task:${i?'TEST-sew-task':'TEST-cut-task'}:round:1`,...(i?['task:TEST-cut-task:completed']:[])],ownTaskId:i?'TEST-sew-task':'TEST-cut-task'}]));
 for(const explicit of [true,false]){
  if(!explicit)for(const fact of Object.values(scope.facts))delete fact.ownTaskId;
  attachFixedJourneySchedule(row,basis,at(4));
  expect(cut.fixedTargets?.map(t=>t.progress.id)).toEqual(['source:development_cutting']);
  expect(sew.fixedTargets?.map(t=>t.progress.id)).toEqual(['source:development_sewing']);
  expect(sew.fixedTargets?.[0]?.progress.goalDelta.actual).toEqual(point(3));
 }
});

it('retains strict non-midnight completion goals through later plan changes and stored fact snapshots',()=>{
 for(const exclusive of [false,true]){
  const original=stored();original.targets['TEST scope']!.a!.end={at:at(6),exclusive,reasons:[]};
  const changed=structuredClone(original);changed.id='TEST later';changed.revision=2;changed.time.now=at(9);changed.targets['TEST scope']!.a!.end={at:at(10),exclusive:!exclusive,reasons:[]};
  const policies=[changed,original].map(plan=>({id:plan.id,at:plan.time.now,plan:plan.input.plan,history:{input:plan.input,targets:plan.targets,revision:plan.revision,time:plan.time}}));
  const row=item();row.stages[1]!.nodes=[node('a','completed',at(1),at(6))];
  const basis=fixedScheduleBasisSnapshot(orderTimeReadingBasis(changed,resource,row,{}, {...evidence(),policies},null));
  expect(basis.scopes[0]!.work.find(w=>w.id==='a')!.completionTarget).toMatchObject({end:at(6),endExclusive:exclusive,targetRevision:'TEST plan:1'});
  expect(evaluateFixedJourneyBasis(basis,at(12),false).scopes[0]!.nodes.find(n=>n.id==='a')!.goalDelta).toMatchObject({kind:exclusive?'late':'on_target',signedValue:exclusive?1/60000:0,targetAt:at(6)});
 }
});

it('keeps actual completion and original plan lag while an explicitly untrusted native R cannot be resurrected by legacy facts',()=>{
 const saved=stored(),view=item();view.asOf=at(12);view.stages[1]!.nodes=[node('a','completed',at(5),at(7))];
 const legacy=build(saved,view),before=structuredClone(legacy);
 const task={task_id:'a:1',task_kind:'a',source_id:resource.id,production_order_id:null,route_version:1,state:'completed',entered_at:new Date(at(5)),entered_quality:'补报未核实',completed_at:new Date(at(7)),completed_quality:'已核实',step_id:null,returned:false,rejected:false,sla_basis:{seconds:18000,calendarRef:'continuous' as const},native_entered_at:new Date(at(5)),warning_at:new Date(at(8))};
 const proof={...evidence(),tasks:[task]},facts={a:{evidence:'task:a:1:round:1',businessCompleted:true,completedAt:at(7)}};
 const basis=orderTimeReadingBasis(saved,resource,view,facts,proof,legacy),result=evaluateFixedJourneyBasis(basis,at(12),false).scopes[0]!.nodes.find(row=>row.id==='a')!;
 expect(basis.scopes[0]!.facts.a!.clockStart.precision).toBe('unknown');expect(result.ownSla.state).toBe('unknown');expect(result.goalDelta).toMatchObject({kind:'late',signedValue:60});expect(basis.scopes[0].facts.a.completed).toEqual(point(7));expect(legacy).toEqual(before);
 expect(basis.scopes[0]!.work.find(work=>work.id==='a')!.responsibilityWarningAt).toBeNull();
});

it('selects each explicitly allocated packing window policy at its own R and never a later shortened arrangement',()=>{
 const saved=stored(),row=item(),earlier=structuredClone(saved.input.plan);
 earlier.company.nodes.a=duration(2);saved.input.plan.company.nodes.a=duration(1);
 const native={a:{evidence:'TEST explicit native allocations',businessCompleted:true,batchCoverageComplete:true,batchWindows:[
  {startedAt:at(2),completedAt:at(5),complete:true,deadline:at(99),warningAt:at(98),evidence:'TEST receipt1',policyAtStart:true},
  {startedAt:at(4),completedAt:at(5),complete:true,deadline:at(99),warningAt:at(98),evidence:'TEST receipt2',policyAtStart:true},
 ]}};
 const basis=orderTimeReadingBasis(saved,resource,row,native,{...evidence(),policies:[{id:'TEST later',at:at(3),plan:saved.input.plan},{id:'TEST first',at:at(0),plan:earlier}]},null);
 expect(basis.scopes[0]!.facts.a!.ownWindows!.map(window=>window.deadline)).toEqual([at(4),at(5)]);
 expect(basis.scopes[0]!.facts.a!.ownWindows!.map(window=>window.warningAt)).toEqual([at(3.4),at(4.7)]);
});
