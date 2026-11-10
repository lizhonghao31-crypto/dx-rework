import {describe,it,expect} from 'vitest';
import {JOURNEY_STAGES,JourneyFilterSchema,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {nextFixedScheduleClassification,evaluateFixedJourneyBasis,fixedScheduleBasisSnapshot,attachFixedJourneySchedule,type FixedScheduleBasis} from '../../apps/api/src/production-platform/fixed-schedule-basis.js';
import {compileJourneySelectionClock} from '../../apps/api/src/production-platform/journey-selection-clock.js';
import {selectJourneySelections,type JourneySelection} from '../../apps/api/src/production-platform/journey-projection.js';
const start=Date.parse('2026-11-02T00:00:00Z'),at=(hour:number)=>new Date(start+hour*3600000).toISOString(),instant=(hour:number)=>({precision:'instant' as const,at:at(hour)}),unknown={precision:'unknown' as const};
const basis=():FixedScheduleBasis=>({version:'fixed-schedule-basis-v1',scopeRevision:'TEST-B0',factRevision:'TEST-facts',termination:null,pending:false,scopes:[{scopeRef:'po:one',lineId:'one',targetRevision:'B0',customerGoal:at(9),terminalIds:['b'],work:[{id:'a',canonicalWorkRef:'a',dependsOn:[],start:at(0),end:at(5),minutes:300,calendar:'continuous',responsibilitySlaRef:null},{id:'b',canonicalWorkRef:'b',dependsOn:['a'],start:at(5),end:at(9),minutes:240,calendar:'continuous',responsibilitySlaRef:null}],facts:{a:{ready:instant(0),clockStart:instant(0),completed:instant(2),businessCompleted:true,waitingForPredecessors:false,evidenceRefs:['TEST native A2']},b:{ready:instant(2),clockStart:instant(2),completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:['TEST native R2']}}}]});
const item=(asOf:string):OrderJourney=>({id:'TEST-mother',sourceId:null,orderId:'TEST-mother',designStyleNo:'TEST',temporaryStyleNo:null,customer:null,category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:at(0),deliveryDate:null,selectedRound:null,adoptedRound:null,sourceVersion:null,instructionVersion:null,lines:[],links:[],asOf,stages:JOURNEY_STAGES.map(stage=>({...stage,state:'uncreated',nodes:[]})),progress:{development:null,bulk:null},hitReasons:[],display:{ruleVersion:'cockpit-display-v1',mainState:'active',earliestShipmentDate:null,missingShipmentDates:0,closedAt:null,actualRatio:0,actualLabel:'TEST',awaitingClosure:false,stages:[],timeRatio:null,timeLabel:'TEST'}});
describe('one fixed classification for complete scope, finite clock boundaries and unchanged KPI',()=>{
 it('compiles customer-H equality and strict zero-buffer crossing, without a per-minute rebuild or early reward',()=>{
  const input=basis(),now=at(6);expect(nextFixedScheduleClassification(input,now)).toBe(at(9));const later=at(9);expect(nextFixedScheduleClassification(input,later)).toBe(new Date(Date.parse(later)+1).toISOString());
  const compiled=compileJourneySelectionClock(item(now),item(now),{plan:null,original:null,facts:{},fixedSchedule:input},[],[],{finished:false,factoryFinished:false,sampleFinished:false,sentLineIds:[]},{now,scenarioId:null,revision:0});
  expect(compiled.expiresAt).toBeNull();expect(compiled.frames.map(frame=>[frame.from,frame.schedule?.lagLineIds.length,frame.schedule?.dueLineIds.length])).toEqual([[at(6),0,0],[at(9),0,1],[new Date(Date.parse(at(9))+1).toISOString(),1,1]]);
  expect(evaluateFixedJourneyBasis(input,at(9),false).scopes[0]!.lagMinutes?.minimum).toBe(0);expect(evaluateFixedJourneyBasis(input,at(10),false).state).toBe('late');
 });
 it('keeps the63rd authorized row in global independent progress selection and count, with only15 displayed',()=>{
  const rows:JourneySelection[]=Array.from({length:63},(_,index)=>({...item(at(6)),id:'TEST-'+String(index).padStart(3,'0'),orderId:'TEST-'+index,scheduleSelection:{state:index===62?'late':'normal',lagLineIds:index===62?['TEST-tail-po']:[],dueLineIds:[],unknownLineIds:[]}}));
  const all=selectJourneySelections(rows,JourneyFilterSchema.parse({scope:'production'}),at(6));expect(all.total).toBe(63);expect(all.items).toHaveLength(15);expect(all.summary).toMatchObject({overdue:0,scheduleLag:1});
  const selected=selectJourneySelections(rows,JourneyFilterSchema.parse({scope:'production',progress:'schedule_lag'}),at(6));expect(selected.total).toBe(1);expect(selected.items[0]!.id).toBe('TEST-062');expect(selected.summary).toMatchObject({all:63,overdue:0,scheduleLag:1});expect(selected.scopeCounts?.production).toBe(63);
  rows[62]!.scheduleSelection={state:'normal',lagLineIds:[],dueLineIds:[],unknownLineIds:[]};expect(selectJourneySelections(rows,JourneyFilterSchema.parse({scope:'production',progress:'schedule_lag'}),at(6)).total).toBe(0);
 });
 it('keeps a late PO and another unknown PO without cross-PO netting, and strips unexpected private fields',()=>{
  const input=basis();input.scopes=[input.scopes[0]!,{...structuredClone(input.scopes[0]!),scopeRef:'po:two',lineId:'two',facts:{}}];const result=evaluateFixedJourneyBasis(input,at(10),false);expect(result.state).toBe('late');expect(result.scopes.map(scope=>scope.state)).toEqual(['late','unknown']);
  Object.assign(input,{actorRoles:['TEST-secret-role']});Object.assign(input.scopes[0]!.work[0]!,{price:'TEST-secret-price'});Object.assign(input.scopes[0]!.facts.a!,{canHandle:true});const shared=JSON.stringify(fixedScheduleBasisSnapshot(input));for(const value of ['TEST-secret-role','TEST-secret-price','canHandle'])expect(shared).not.toContain(value);
 });
 it('requires native evidence recheck at a future actual boundary rather than manufacturing an event when time passes',()=>{
  const input=basis(),now=at(6);input.scopes[0]!.facts={...input.scopes[0]!.facts,b:{...input.scopes[0]!.facts.b!,businessCompleted:true,completed:instant(8)}};
  const compiled=compileJourneySelectionClock(item(now),item(now),{plan:null,original:null,facts:{},fixedSchedule:input},[],[],{finished:false,factoryFinished:false,sampleFinished:false,sentLineIds:[]},{now,scenarioId:null,revision:0});expect(compiled.expiresAt).toBe(at(8));expect(compiled.frames.every(frame=>frame.from<at(8))).toBe(true);
 });
 it('retains completed delivery and its actual target delta after a later administrative termination',()=>{
  const input=basis();input.scopes[0]!.facts={...input.scopes[0]!.facts,b:{...input.scopes[0]!.facts.b!,businessCompleted:true,completed:instant(8)}};input.termination={kind:'cancelled',at:at(10),precision:'instant',originEventRef:'TEST original cancel',scopeRef:'TEST mother'};
  const result=evaluateFixedJourneyBasis(input,at(20),false);expect(result.state).toBe('normal');expect(result.scopes[0]!.nodes.find(node=>node.id==='b')!.goalDelta).toMatchObject({kind:'early',signedValue:-60});expect(result.durationSummary.finalActualSpanMinutes).toMatchObject({minimum:480,maximum:480});
 });
 it('selects a late development source without inventing a PO or customer delivery promise',()=>{
  const input=basis();input.scopes[0]!.lineId=null;input.scopes[0]!.scopeRef='source:TEST';input.scopes[0]!.customerGoal=null;
  const fixed=evaluateFixedJourneyBasis(input,at(10),false),row={...item(at(10)),orderId:null,sourceId:'TEST-source',fixedSchedule:fixed};
  const result=selectJourneySelections([row],JourneyFilterSchema.parse({scope:'development',progress:'schedule_lag'}),at(10));expect(result.total).toBe(1);expect(result.summary).toMatchObject({scheduleLag:1,customerDuePassed:0});expect(fixed.durationSummary.planSpanMinutes).toBe(540);
 });
 it('binds two native craft task rows to their own targets instead of matching both by the shared display key',()=>{
  const input=basis(),scope=input.scopes[0]!;
  scope.work=scope.work.map((work,index)=>({...work,id:index?'bulk_embroidery':'bulk_printing',dependsOn:[]}));scope.terminalIds=['bulk_embroidery'];scope.facts={bulk_printing:{...scope.facts.a!,evidenceRefs:['task:TEST-print:round:1']},bulk_embroidery:{...scope.facts.b!,evidenceRefs:['task:TEST-embroidery:round:1']}};
  const row=item(at(6));row.stages[0]!.nodes=['TEST-print','TEST-embroidery'].map(instanceId=>({instanceId,key:'process_logistics',current:true,state:'active',records:[]})) as OrderJourney['stages'][number]['nodes'];
  attachFixedJourneySchedule(row,input,at(6));expect(row.stages[0]!.nodes.map(node=>[node.fixedTargets!.length,node.expectedAt])).toEqual([[1,at(5)],[1,at(9)]]);
 });
});
