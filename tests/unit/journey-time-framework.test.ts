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
