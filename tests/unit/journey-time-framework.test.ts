import type {FixedScheduleProgress} from '@dx-rework/contracts';
import type {FixedScheduleBasis} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {describe,it,expect} from 'vitest';
import {evaluateFixedScheduleScope,type ScheduleScopeInput,type ScheduleFact} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {evaluateJourneyFramework,frameworkCompletion,type JourneyFrameworkBasis} from '../../apps/api/src/production-platform/journey-time-framework.js';
const at=(hours:number)=>new Date(Date.parse('2027-03-01T00:00:00Z')+hours*3600000).toISOString();
const unknown={precision:'unknown'} as const;
const pending=():ScheduleFact=>({ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:[]});
function scope():ScheduleScopeInput{return {plannedReadiness:true,scopeRef:'po:red',lineId:'red',targetRevision:'v1',customerGoal:at(48),terminalIds:['b'],work:[
 {id:'a',canonicalWorkRef:'source:shared:a',dependsOn:[],start:at(0),end:at(2),minutes:120,calendar:'continuous',responsibilitySlaRef:'own:a',responsibilityMinutes:120,responsibilityCalendar:'continuous'},
 {id:'b',canonicalWorkRef:'po:red:b',dependsOn:['a'],start:at(2),end:at(5),minutes:180,calendar:'continuous',responsibilitySlaRef:'own:b',responsibilityMinutes:180,responsibilityCalendar:'continuous'}],facts:{a:pending(),b:pending()}};}
function basis(s:ScheduleScopeInput):JourneyFrameworkBasis{return [{scopeRef:s.scopeRef,lineId:s.lineId,route:'B',reference:'v1',revision:1,effectiveAt:at(0),customerDate:'2027-03-02',milestones:[{key:'processing_dispatch',date:'2027-03-01',at:'2027-03-01T16:00:00Z',plannedAt:at(5),workIds:['b']}]}];}
describe('Journey three-layer scoped projection',()=>{
 it('retains the plan before readiness without creating responsibility or actual events, and never adds now per descendant',()=>{
  const s=scope(),result=evaluateFixedScheduleScope(s,at(1));
  expect(result.nodes.map(n=>n.availabilityBound?.earliest)).toEqual([at(3),at(6)]);
  expect(result.nodes.map(n=>n.ownSla.state)).toEqual(['unknown','unknown']);
  expect(s.facts.b!.clockStart).toEqual(unknown);
  expect(result.completionEstimate).toMatchObject({kind:'lower_bound',earliest:at(6),latest:null});
  const view=evaluateJourneyFramework(basis(s),[s],[result],at(1),null);
  expect(view.scopes[0]!.milestones[0]).toMatchObject({plannedAt:at(5),actual:unknown,forecast:{kind:'lower_bound',earliest:at(6),latest:null}});
 });
 it('does not lose the next plan when predecessors complete before its own readiness',()=>{
  const s=scope();s.facts.a={...pending(),businessCompleted:true,completed:{precision:'instant',at:at(2)}};
  const result=evaluateFixedScheduleScope(s,at(4));
  expect(result.nodes[1]!.availabilityBound?.earliest).toBe(at(7));
  expect(result.nodes[1]!.ownSla.deadlineAt).toBeNull();
  expect(result.nodes[1]!.goalDelta.targetAt).toBe(at(5));
 });
 it('keeps legacy unknown readiness behavior, rather than inventing a new plan for old data',()=>{
  const s=scope();delete s.plannedReadiness;
  expect(evaluateFixedScheduleScope(s,at(1)).completionEstimate?.kind).toBe('unknown');
 });
 it('does not ignore unknown actual times or turn a date into an instant',()=>{
  const s=scope();s.facts.a!.businessCompleted=true;s.facts.b!.businessCompleted=true;
  s.facts.a!.completed={precision:'instant',at:at(1)};
  expect(frameworkCompletion(s,['a','b'],at(30))).toEqual({completed:true,actual:unknown});
  s.facts.b!.completed={precision:'date',date:'2027-03-01'};
  expect(frameworkCompletion(s,['a','b'],at(30)).actual).toEqual({precision:'date',date:'2027-03-01'});
 });
 it('deduplicates shared work across PO and milestones and stops unfinished estimates on termination',()=>{
  const red=scope(),blue=structuredClone(red);blue.scopeRef='po:blue';blue.lineId='blue';blue.work[1]!.canonicalWorkRef='po:blue:b';
  red.facts.a={...pending(),businessCompleted:true,completed:{precision:'instant',at:at(1)}};blue.facts.a=structuredClone(red.facts.a);
  const stop={kind:'special_closure' as const,at:at(2)},scopes=[red,blue],view=evaluateJourneyFramework([...basis(red),...basis(blue)],scopes,scopes.map(s=>evaluateFixedScheduleScope(s,at(30),stop)),at(30),stop);
  expect(view).toMatchObject({applicableWork:3,completedWork:1});
  expect(view.scopes.every(s=>s.milestones[0]!.forecast.kind==='terminated')).toBe(true);
  expect(view.scopes.every(s=>!s.milestones[0]!.completed)).toBe(true);
 });
});
it('keeps the adopted reserve on the actual cross-stage dependency once',()=>{
 const s=scope();s.work[1]!.dependencyReserves={a:{minutes:60,calendar:'continuous'}};s.work[1]!.start=at(3);s.work[1]!.end=at(6);
 s.facts.a={...pending(),businessCompleted:true,completed:{precision:'instant',at:at(4)}};
 expect(evaluateFixedScheduleScope(s,at(4)).nodes[1]!.availabilityBound?.earliest).toBe(at(8));
});
it('retains a known milestone gap when another required branch has unknown actual time',()=>{
 const s=scope();s.facts.a!.businessCompleted=true;s.facts.a!.completed={precision:'instant',at:at(17)};s.facts.b!.businessCompleted=true;
 const b=basis(s);b[0]!.milestones[0]!.workIds=['a','b'];
 const view=evaluateJourneyFramework(b,[s],[evaluateFixedScheduleScope(s,at(20))],at(20),null).scopes[0]!.milestones[0]!;
 expect(view).toMatchObject({actual:{precision:'unknown'},forecast:{kind:'unknown'},feasibility:'insufficient',lateMinutes:60});
});

it('does not certify an unfinished over-budget lower bound as sufficient before its milestone',()=>{
 const s=scope();s.work=[s.work[0]!];s.terminalIds=['a'];s.facts.a!.ready={precision:'instant',at:at(0)};s.facts.a!.clockStart={precision:'instant',at:at(0)};
 const b=basis(s);b[0]!.milestones[0]!.workIds=['a'];
 for(const hour of [4,16,17]){
  const progress=evaluateFixedScheduleScope(s,at(hour)),view=evaluateJourneyFramework(b,[s],[progress],at(hour),null).scopes[0]!.milestones[0]!;
  expect(view.forecast).toMatchObject({kind:'lower_bound',earliest:at(hour),latest:null});
  expect(view.feasibility).toBe(hour<16?'unknown':'insufficient');
  expect(view.lateMinutes).toBe(hour<16?null:hour===16?1/60000:60);
  expect(progress.nodes[0]!.ownSla.state).toBe('overdue');
  expect(view.delta.kind).toBe(hour<16?'on_target':'late');
 }
});
it('requires a finite latest bound strictly before the exclusive milestone deadline',()=>{
 const s=scope(),b=basis(s);b[0]!.milestones[0]!.workIds=['a'];
 const progress=evaluateFixedScheduleScope(s,at(0));
 for(const [earliest,latest,expected] of [[14,15,'sufficient'],[14,16,'unknown'],[14,17,'unknown'],[16,17,'insufficient']] as const){
  progress.nodes[0]!.availabilityBound={earliest:at(earliest),latest:at(latest)};progress.nodes[0]!.estimateKind='conditional';
  const view=evaluateJourneyFramework(b,[s],[progress],at(0),null).scopes[0]!.milestones[0]!;
  expect(view.feasibility).toBe(expected);expect(view.lateMinutes).toBe(expected==='sufficient'?0:expected==='unknown'?null:1/60000);
 }
});
it('projects preparation facts through original records without duplicating tasks or changing clock/quantity denominators',async()=>{
 const {attachFrameworkEvents}=await import('../../apps/api/src/production-platform/journey-framework-events.js');
 const s=scope();s.work[0]!.id='design_handover:whole';s.facts[s.work[0]!.id]=pending();delete s.facts.a;s.work=[s.work[0]!];s.terminalIds=[s.work[0]!.id];
 const progress={scopes:[evaluateFixedScheduleScope(s,at(1))]} as FixedScheduleProgress;
 const b={framework:basis(s),scopes:[s],termination:null} as FixedScheduleBasis;
 const item={orderId:'TEST-order',lines:[{id:'red',po:'TEST-PO'}],stages:[{key:'preparation',nodes:[]}]} as unknown as OrderJourney;
 const before=structuredClone(s);
 attachFrameworkEvents(item,b,progress);attachFrameworkEvents(item,b,progress);
 expect(item.stages[0]!.nodes).toHaveLength(1);
 const second=structuredClone(s);second.scopeRef='po:blue';second.lineId='blue';b.scopes.push(second);progress.scopes.push(evaluateFixedScheduleScope(second,at(1)));
 attachFrameworkEvents(item,b,progress);expect(item.stages[0]!.nodes).toHaveLength(1);expect(item.stages[0]!.nodes[0]!.fixedTargets).toHaveLength(2);expect(item.stages[0]!.nodes[0]!.records[0]!.lineId).toBeNull();
 expect(item.stages[0]!.nodes[0]).toMatchObject({label:'设计资料交接',planningOnly:true,countsInProgress:false,enteredAt:null,actualAt:null,owner:null,records:[{url:'/ui/digital-production?bulk=TEST-order',mode:'read'}]});
 expect(s).toEqual(before);
 attachFrameworkEvents(item,{...b,framework:undefined},progress);
 expect(item.stages[0]!.nodes).toHaveLength(1);
});

it('preserves an exclusive planned date boundary without accepting an actual next-midnight completion',()=>{
 const s=scope();s.work=[{...s.work[0]!,start:at(16),end:at(16),minutes:0,responsibilitySlaRef:null,startExclusive:true,endExclusive:true,targetPrecision:'date',targetDate:'2027-03-01'}];s.terminalIds=['a'];
 const b=basis(s);b[0]!.milestones[0]!.workIds=['a'];
 const read=(hour:number)=>evaluateJourneyFramework(b,[s],[evaluateFixedScheduleScope(s,at(hour))],at(hour),null).scopes[0]!.milestones[0]!;
 expect(read(0)).toMatchObject({feasibility:'sufficient',lateMinutes:0,delta:{kind:'on_target'}});
 s.facts.a={...pending(),businessCompleted:true,completed:{precision:'instant',at:at(16)}};
 expect(read(17)).toMatchObject({feasibility:'insufficient',lateMinutes:1/60000,delta:{kind:'late',signedValue:1}});
 s.facts.a={...pending(),businessCompleted:true,completed:{precision:'date',date:'2027-03-01'}};
 expect(read(17)).toMatchObject({feasibility:'sufficient',delta:{kind:'on_target'}});
});

it('evaluates an event constraint without rewriting its frozen planning position or starting responsibility',()=>{
 const s=scope();s.work=[{...s.work[0]!,start:at(0),end:at(0),minutes:0,responsibilitySlaRef:null,eventTarget:{end:at(16),targetPrecision:'date',targetDate:'2027-03-01',exclusive:true}}];s.terminalIds=['a'];
 const original=structuredClone(s);
 const node=evaluateFixedScheduleScope(s,at(1)).nodes[0]!;
 expect(node.goalDelta).toMatchObject({kind:'on_target',targetDate:'2027-03-01'});
 expect(node.ownSla).toMatchObject({state:'not_adopted',deadlineAt:null});
 expect(node.availabilityBound).toEqual({earliest:at(16),latest:at(16),exclusive:true});
 expect(s).toEqual(original);
 expect(evaluateFixedScheduleScope(s,at(17)).nodes[0]!.goalDelta.kind).toBe('late');
 s.facts.a={...pending(),businessCompleted:true,completed:{precision:'instant',at:at(2)}};
 expect(evaluateFixedScheduleScope(s,at(17)).nodes[0]).toMatchObject({state:'normal',goalDelta:{kind:'on_target'},availabilityBound:{earliest:at(2),latest:at(2)}});
});

it('keeps a future exclusive event bound uncertain after an upstream overrun, without inventing a one-millisecond gap',()=>{
 const s=scope();s.work[1]={...s.work[1]!,start:at(16),end:at(16),minutes:0,responsibilitySlaRef:null,eventTarget:{end:at(16),targetPrecision:'date',targetDate:'2027-03-01',exclusive:true}};
 s.facts.a={...pending(),ready:{precision:'instant',at:at(0)},clockStart:{precision:'instant',at:at(0)}};
 const frozen=structuredClone(s),read=(hour:number)=>{const result=evaluateFixedScheduleScope(s,at(hour));return {result,milestone:evaluateJourneyFramework(basis(s),[s],[result],at(hour),null).scopes[0]!.milestones[0]!};};
 // All hours UTC; deadline16Z is Beijing March2 00:00 exclusive.
 for(const hour of [4,10,16-1/3600000]){
  const {result,milestone}=read(hour);expect(result.nodes[1]).toMatchObject({estimateKind:'lower_bound',availabilityBound:{earliest:at(16),latest:at(16),exclusive:true},goalDelta:{kind:'on_target'}});
  expect(milestone).toMatchObject({forecast:{kind:'lower_bound',earliest:at(16),latest:null},feasibility:'unknown',lateMinutes:null,delta:{kind:'on_target'}});
 }
 for(const hour of [16,16+1/3600000,17]){
  const {result,milestone}=read(hour);expect(result.nodes[1]!.availabilityBound?.exclusive).not.toBe(true);
  expect(milestone.feasibility).toBe('insufficient');expect(milestone.lateMinutes).toBeGreaterThan(0);expect(milestone.delta.kind).toBe('late');
 }
 expect(s).toEqual(frozen);
});
it('does not hide a strict actual lower bound arriving at the deadline, or a later known parallel branch',()=>{
 const s=scope();s.work[1]={...s.work[1]!,start:at(16),end:at(16),minutes:0,responsibilitySlaRef:null,eventTarget:{end:at(16),targetPrecision:'date',targetDate:'2027-03-01',exclusive:true}};
 s.facts.a={...pending(),businessCompleted:true,completed:{precision:'instant',at:at(16)}};
 let result=evaluateFixedScheduleScope(s,at(16));expect(result.nodes[1]!.availabilityBound?.exclusive).not.toBe(true);
 expect(evaluateJourneyFramework(basis(s),[s],[result],at(16),null).scopes[0]!.milestones[0]).toMatchObject({feasibility:'insufficient',lateMinutes:1/60000});
 s.facts.a=pending();const b=basis(s);b[0]!.milestones[0]!.workIds=['a','b'];result=evaluateFixedScheduleScope(s,at(4));
 result.nodes[0]!.availabilityBound={earliest:at(17),latest:at(17)};result.nodes[0]!.estimateKind='lower_bound';
 expect(evaluateJourneyFramework(b,[s],[result],at(4),null).scopes[0]!.milestones[0]).toMatchObject({feasibility:'insufficient',lateMinutes:60});
});
it('applies adopted dependency reserves before deciding whether a future event endpoint is open',()=>{
 const s=scope();s.work[0]={...s.work[0]!,start:at(0),end:at(15),minutes:900};
 s.work[1]={...s.work[1]!,start:at(16),end:at(16),minutes:0,responsibilitySlaRef:null,dependencyReserves:{a:{minutes:60,calendar:'continuous'}},eventTarget:{end:at(16),targetPrecision:'date',targetDate:'2027-03-01',exclusive:true}};
 const result=evaluateFixedScheduleScope(s,at(0));
 expect(result.nodes[1]!.availabilityBound).toEqual({earliest:at(16),latest:at(16)});
 expect(evaluateJourneyFramework(basis(s),[s],[result],at(0),null).scopes[0]!.milestones[0]).toMatchObject({feasibility:'insufficient',lateMinutes:1/60000});
});
