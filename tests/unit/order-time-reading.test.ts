import {describe,expect,it} from 'vitest';
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
  expect(visual.startedAt).toBe(at(0));expect(visual.timeRatio).toBe(0.1);expect(visual.actual.at).toBeNull();
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
