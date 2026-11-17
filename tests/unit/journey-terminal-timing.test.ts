import {describe,expect,it} from 'vitest';
import type {JourneyNode,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {attachJourneyTerminalTiming} from '../../apps/api/src/production-platform/journey-terminal-timing.js';
import type {JourneyTermination} from '../../apps/api/src/production-platform/journey-termination.js';
import {evaluateSlaPlan,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import {attachJourneySupervision} from '../../apps/api/src/production-platform/journey-supervision.js';
import {compileJourneySelectionClock} from '../../apps/api/src/production-platform/journey-selection-clock.js';
import {journeySelectionNodes} from '../../apps/api/src/production-platform/journey-selection-facts.js';
import {minimalJourneyFacts} from '../../apps/api/src/production-platform/journey-fact-model.js';

const at=(hours:number)=>new Date(Date.parse('2026-11-15T00:00:00.000Z')+hours*3600000).toISOString();
const time=(complete=false):JourneyTiming=>({id:'development_pattern',label:'纸样',stage:'development',kind:'duration',status:complete?'completed_late':'overdue',actualStart:at(0),actualEnd:complete?at(6):null,target:{at:at(4),exclusive:false,reasons:[]},original:{at:at(3),exclusive:false,reasons:[]},current:{at:at(3),exclusive:false,reasons:[]},forecast:{at:null,exclusive:false,reasons:['原窗口已过']},forecastBasis:complete?'actual':'unknown'});
const subject=(timing:JourneyTiming)=>{
 const node={key:'development_pattern',instanceId:'TEST-task',current:true,state:'active',timing,risks:['overdue'],overdueSeconds:null} as JourneyNode;
 const item={orderId:'TEST-order',sourceId:null,asOf:at(40),supervision:{nodes:[timing]},stages:[{nodes:[node]}]} as OrderJourney;
 return {node,item};
};
const facts:Record<string,SlaNodeFact>={development_pattern:{startedAt:at(0),standardCalendar:'continuous',evidence:'task:TEST-task'}};
const terminal=(hours:number|null,kind:JourneyTermination['kind']='special_closure'):JourneyTermination=>({kind,at:hours===null?null:at(hours),precision:hours===null?'unknown':'instant',originEventRef:'TEST original termination event',scopeRef:'order:TEST-order'});
describe('unfinished legacy supervision stops at its original termination, never delivery A',()=>{
 it.each([0,8])('freezes original elapsed and overdue at C=%s across later observations',hours=>{
  for(const observed of [hours,12,40]){
   const timing=time(),{node,item}=subject(timing);item.asOf=at(observed);
   attachJourneyTerminalTiming(item,facts,terminal(hours),at(observed));
   expect(timing).toMatchObject({status:'terminated',actualStart:at(0),actualEnd:null,target:{at:at(4)},forecast:{at:null},termination:{kind:'special_closure',at:at(hours),elapsedSeconds:hours*3600,overdueSeconds:Math.max(0,hours-4)*3600}});
   expect(node.risks).not.toContain('overdue');expect(node.risks).not.toContain('due_soon');expect(node.overdueSeconds).toBe(Math.max(0,hours-4)*3600);
   expect(item.asOf).toBe(at(observed));expect(timing.original.at).toBe(at(3));
  }
 });
 it.each(['unknown','before-start','future'] as const)('keeps %s termination responsibility unknown instead of zero overtime',mode=>{
  const timing=time(),{item,node}=subject(timing),input=terminal(mode==='unknown'?null:mode==='future'?50:0);
  if(mode==='before-start')timing.actualStart=at(1);
  attachJourneyTerminalTiming(item,facts,input,at(40));
  expect(timing).toMatchObject({status:'unknown',actualEnd:null,termination:{elapsedSeconds:null,overdueSeconds:null}});
  expect(node.risks).toContain('unknown');expect(node.overdueSeconds).toBeNull();
 });
 it('preserves independently completed A and its rating after closure, and distinguishes cancellation',()=>{
  const done=time(true),{item}=subject(done);attachJourneyTerminalTiming(item,{development_pattern:{...facts.development_pattern!,completedAt:at(6),businessCompleted:true}},terminal(8),at(40));
  expect(done).toMatchObject({status:'completed_late',actualEnd:at(6)});expect(done.termination).toBeUndefined();
  const running=time(),another=subject(running);attachJourneyTerminalTiming(another.item,facts,terminal(8,'cancelled'),at(40));
  expect(running.termination?.kind).toBe('cancelled');expect(running.forecast.reasons.join()).toContain('已取消');
 });
 it('does not terminate paused/ordinary work or borrow another mother termination',()=>{
  const timing=time(),{item}=subject(timing),before=structuredClone(timing);
  attachJourneyTerminalTiming(item,facts,null,at(40));attachJourneyTerminalTiming(item,facts,{...terminal(8),scopeRef:'order:TEST-other'},at(40));expect(timing).toEqual(before);
 });
});

it('retains terminal facts through shared rebuild and finite selector frames at C, D+1ms and D+30min+1ms',()=>{
 const plan:SlaPlan={nodes:[{id:'development_pattern',label:'纸样',stage:2,parameterKey:'development_pattern',kind:'duration',minutes:240,offsetDays:null,applicable:'yes',countsProgress:true,dependsOn:[],anchorKey:'published',targetKey:null,includedIn:null,includedPosition:'start'}],anchors:{published:{precision:'instant',value:at(0),source:'TEST real publication'}},warningPercent:70,stageBufferMinutes:0};
 const node:JourneyNode={key:'development_pattern',instanceId:'TEST-task',label:'纸样',stage:'development',state:'active',round:1,occurrence:1,current:true,owner:null,operator:null,assignmentHistory:[],expectedAt:at(4),expectedKind:'sla',expectedPrecision:'instant',actualAt:null,actualQuality:'missing',enteredAt:at(0),sla:'running',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[{domain:'task',id:'TEST-task',url:null,version:1,lineId:null,mode:'read'}],inheritedFrom:null,countsInProgress:true,unavailableReason:null};
 const root:OrderJourney={id:'TEST-order',sourceId:null,orderId:'TEST-order',designStyleNo:'TEST',temporaryStyleNo:null,customer:null,category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:at(0),deliveryDate:null,selectedRound:1,adoptedRound:1,sourceVersion:1,instructionVersion:null,lines:[],links:[],stages:[{key:'development',label:'开发',state:'active',nodes:[node]}],progress:{development:null,bulk:null},hitReasons:[]};
 const inputs={plan,original:plan,facts,termination:terminal(0)};
 const stored=JSON.parse(JSON.stringify(minimalJourneyFacts(root,inputs)));
 expect(stored.sla.termination).toEqual(inputs.termination);
 for(const now of [at(0),new Date(Date.parse(at(4))+1).toISOString(),new Date(Date.parse(at(4.5))+1).toISOString()]){
  const raw=structuredClone(root);raw.asOf=now;const item=structuredClone(raw),time={now,scenarioId:null,revision:0};
  attachJourneySupervision(item,stored.sla.plan,stored.sla.original,evaluateSlaPlan(stored.sla.plan,stored.sla.facts,time),time,{original:1,current:1},false,stored.sla);
  expect(item.stages[0]!.nodes[0]!.timing).toMatchObject({status:'terminated',actualEnd:null,target:{at:at(4)},termination:{elapsedSeconds:0,overdueSeconds:0}});
  const compiled=compileJourneySelectionClock(item,raw,stored.sla,[{id:'TEST-task',kind:'development_pattern',state:'active',sourceId:null,orderId:'TEST-order',assigneeId:null,requiredRole:'TEST',routeInstanceId:'TEST-route',routeVersion:1,policyVersion:1,enteredAt:at(0),dueAt:at(4),warningAt:at(2.8),deadlineMode:'duration',deadlineExclusive:false}],journeySelectionNodes(raw.stages[0]!.nodes),{finished:true,terminal:true,factoryFinished:false,sampleFinished:false,sentLineIds:[]},time);
  expect(compiled.expiresAt).toBeNull();expect(compiled.frames).toHaveLength(1);expect(compiled.frames[0]!.risks[0]!.risks).not.toContain('overdue');expect(compiled.frames[0]!.risks[0]!.risks).not.toContain('due_soon');
 }
});
