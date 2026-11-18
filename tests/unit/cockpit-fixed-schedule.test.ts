import {nodeOverdue,nodeStatus,nodeTerminationLabel,nodeIsInProgress,nodeIsTerminated,stageStatus,representativeCockpitNodes,matchingNodes} from '../../apps/web/src/digital-journey-cockpit-model.js';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {originalNodeDeadlineLabel} from '../../apps/web/src/journey-sla-details.js';
import {describe,it,expect} from 'vitest';
import type {JourneyNode,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {evaluateFixedScheduleScope,type ScheduleScopeInput} from '../../apps/api/src/production-platform/fixed-schedule-progress.js';
import {CockpitActualDates,CockpitFixedTargetDates,cockpitTargetDifference,cockpitOwnStatus,cockpitDuration,cockpitDurationRange,observedTargetDelta,cockpitScopeProgress,cockpitScheduleReason} from '../../apps/web/src/cockpit-fixed-schedule.js';
import {CockpitNodeSummary} from '../../apps/web/src/cockpit-node-summary.js';
import {cockpitNodeStatus} from '../../apps/web/src/cockpit-node-rows.js';
const scope=(id:string,end='2026-11-10T10:00:00.000Z'):ScheduleScopeInput=>({scopeRef:'po:'+id,lineId:id,targetRevision:'TEST1',work:[{id:'work',canonicalWorkRef:'work:'+id,dependsOn:[],start:'2026-11-10T08:00:00.000Z',end,minutes:120,calendar:'continuous',responsibilitySlaRef:'TEST original adopted',responsibilityMinutes:120,responsibilityCalendar:'continuous'}],facts:{work:{ready:{precision:'instant',at:'2026-11-10T08:00:00.000Z'},clockStart:{precision:'instant',at:'2026-11-10T08:00:00.000Z'},completed:{precision:'unknown'},businessCompleted:false,waitingForPredecessors:false,evidenceRefs:['TEST original readiness']}},terminalIds:['work'],customerGoal:end});
const projected=(input=scope('A'),now='2026-11-10T10:00:00.000Z')=>evaluateFixedScheduleScope(input,now).nodes[0]!;
const node=(id:string,p=projected()):JourneyNode=>({key:'bulk_cutting',instanceId:id,label:'开裁',stage:'cutting',state:'active',current:true,round:1,occurrence:1,owner:null,operator:null,assignmentHistory:[],expectedAt:null,expectedKind:'unset',expectedPrecision:'missing',actualAt:null,actualQuality:'missing',enteredAt:null,sla:'running',completionResult:null,overdueSeconds:null,risks:[],blockers:[],records:[],inheritedFrom:null,countsInProgress:true,unavailableReason:null,fixedTargets:[{scopeRef:p.scopeRef,lineId:id,progress:p}]});
const responsibility=(id:string,stopped=false):JourneyTiming=>({id,label:'TEST original PO '+id,stage:'cutting',kind:'duration',status:stopped?'terminated':'running',actualStart:'2026-11-10T08:00:00.000Z',actualEnd:null,target:{at:'2026-11-10T10:00:00.000Z',reasons:[]},original:{at:'2026-11-10T10:00:00.000Z',reasons:[]},current:{at:'2026-11-10T10:00:00.000Z',reasons:[]},forecast:{at:null,reasons:[]},forecastBasis:'unknown',...(stopped?{termination:{kind:'special_closure',at:'2026-11-10T14:00:00.000Z',sourceRef:'TEST exact original closure',elapsedSeconds:21600,overdueSeconds:14400}}:{})});
it.each(['active','blocked'] as const)('excludes a stopped %s from detail progress but preserves state, missing A and frozen240 minutes',state=>{
 const p=evaluateFixedScheduleScope(scope('A'),'2026-11-11T14:00:00.000Z',{kind:'special_closure',at:'2026-11-10T14:00:00.000Z'}).nodes[0]!,value={...node('A',p),state},before=structuredClone(value);
 expect(nodeIsInProgress(value)).toBe(false);expect(nodeIsTerminated(value)).toBe(true);expect(value.fixedTargets![0]!.progress.ownSla.overdueMinutes).toEqual({minimum:240,maximum:240});expect(value).toEqual(before);
 value.fixedTargets![0]!.progress.ownSla.state='unknown';expect(nodeIsInProgress(value)).toBe(false);
});
it('keeps real multi-scope progress and mixed original timing DTOs open instead of reusing the any-termination label as a whole-node decision',()=>{
 const stopped=evaluateFixedScheduleScope(scope('A'),'2026-11-10T14:00:00.000Z',{kind:'special_closure',at:'2026-11-10T14:00:00.000Z'}).nodes[0]!,value=node('A',stopped);
 value.fixedTargets!.push(node('B').fixedTargets![0]!);value.timings=[responsibility('po:A',true),responsibility('po:B')];const before=structuredClone(value);
 expect(nodeTerminationLabel(value)).toBe('计时已终止');expect(nodeIsTerminated(value)).toBe(false);expect(nodeIsInProgress(value)).toBe(true);expect(value).toEqual(before);
 delete value.fixedTargets;expect(nodeIsInProgress(value)).toBe(true);
 value.timings![1]!.status='unknown';expect(nodeIsInProgress(value)).toBe(true);
 value.timings![1]!.status='completed_unrated';expect(nodeIsInProgress(value)).toBe(false);
});
it('retains an unfinished fixed scope even when all available legacy timings are stopped, and does not mistake missing time for termination',()=>{
 const value=node('A');value.timings=[responsibility('po:A',true)];expect(nodeIsInProgress(value)).toBe(true);
 delete value.timings;value.fixedTargets![0]!.progress.ownSla.state='unknown';expect(nodeIsInProgress(value)).toBe(true);
 delete value.fixedTargets;value.timing={...responsibility('po:A',true),status:'unknown',termination:{kind:'cancelled',at:null,sourceRef:'TEST cancellation with unknown occurrence',elapsedSeconds:null,overdueSeconds:null}};expect(nodeIsInProgress(value)).toBe(false);
});
it('never adds original non-working states to detail progress',()=>{
 for(const state of ['completed','inherited','cancelled','not_applicable','unavailable','pending','uncreated'] as const)expect(nodeIsInProgress({...node('A'),state})).toBe(false);
});
it('shows proven terminal responsibility without a planned target in the node and compact summary, preserving frozen delay and missing A',()=>{
 const input=scope('A');input.work=[{...input.work[0]!,start:null,end:null}];
 for(const asOf of ['2026-11-10T14:00:00.000Z','2026-11-11T14:00:00.000Z']){
  const progress=evaluateFixedScheduleScope(input,asOf,{kind:'special_closure',at:'2026-11-10T14:00:00.000Z'}).nodes[0]!;
  expect(progress).toMatchObject({state:'terminated',businessCompleted:false,goalDelta:{kind:'terminated'},ownSla:{state:'terminated',overdueMinutes:{minimum:240,maximum:240}}});
  const value={...node('A',progress),sla:'unavailable' as const};
  expect(nodeTerminationLabel(value)).toBe('计时已终止');expect(nodeStatus(value)).toBe('计时已终止');expect(cockpitNodeStatus(value)).toBe('计时已终止');
  const stage={key:'cutting' as const,label:'开裁',state:'active' as const,nodes:[value]},order={stages:[stage],hitReasons:[]} as OrderJourney;
  expect(stageStatus(stage)).toBe('计时已终止');expect(representativeCockpitNodes(order)).toEqual([]);expect(matchingNodes(order,'active')).toEqual([]);
  const html=renderToStaticMarkup(createElement(CockpitNodeSummary,{nodes:[value],selectedId:undefined,onSelect:()=>undefined}));
  expect(html).toContain('计时已终止');expect(html).not.toContain('进行中');expect(value.actualAt).toBeNull();expect(value.state).toBe('active');
 }
});
it('does not turn one terminated fixed scope into terminal status for a still-running sibling',()=>{
 const input=scope('A');input.work=[{...input.work[0]!,start:null,end:null}];
 const stopped=evaluateFixedScheduleScope(input,'2026-11-10T14:00:00.000Z',{kind:'special_closure',at:'2026-11-10T14:00:00.000Z'}).nodes[0]!,value=node('A',stopped);
 value.fixedTargets!.push(node('B').fixedTargets![0]!);expect(nodeTerminationLabel(value)).toBeNull();
});
describe('approved fixed schedule presentation without changing business classification',()=>{
 it('uses the same scoped actual as the delta, keeping distinct PO dates and unknown instead of stale metadata',()=>{
  const value=node('A');value.state='completed';value.actualAt='2026-01-01T00:00:00Z';value.actualQuality='verified';value.fixedTargets![0]!.progress.goalDelta.actual={precision:'instant',at:'2026-11-10T09:00:00Z'};
  const second=node('B').fixedTargets![0]!;second.progress.goalDelta.actual={precision:'date',date:'2026-11-11'};value.fixedTargets!.push(second);
  let html=renderToStaticMarkup(createElement(CockpitActualDates,{node:value}));expect(html).toContain('2026-11-10T09:00:00Z');expect(html).toContain('2026-11-11');expect(html).not.toContain('2026-01-01');
  value.fixedTargets![0]!.progress.goalDelta.actual={precision:'unknown'};html=renderToStaticMarkup(createElement(CockpitActualDates,{node:value}));expect(html).toContain('完成时间待核实');expect(html).not.toContain('2026-01-01');
 });

 it('shows green negative zero before target and a signed subminute delay without rounding it into normal zero',()=>{expect(cockpitTargetDifference([node('A')])).toMatchObject({text:'-0',tone:'success'});expect(cockpitTargetDifference([node('A',projected(scope('A'),'2026-11-10T10:00:00.001Z'))])).toMatchObject({text:'+<0.01天',tone:'danger'});});
 it('never offsets a late PO with an early sibling and keeps unknown scopes honest',()=>{const early=scope('A');early.facts={work:{...early.facts.work!,businessCompleted:true,completed:{precision:'instant',at:'2026-11-10T09:00:00.000Z'}}};const a=node('A',projected(early)),b=node('B',projected(scope('B'),'2026-11-10T12:00:00.000Z'));expect(cockpitTargetDifference([a,b])).toMatchObject({text:'+0.08天',tone:'danger'});const unknown=node('C',{...projected(scope('C')),goalDelta:{...projected(scope('C')).goalDelta,kind:'unknown',signedValue:null}});expect(cockpitTargetDifference([a,unknown]).text).toBe('—');expect(cockpitTargetDifference([unknown,b]).text).toBe('+0.08天');});
 it('ticks only unfinished known target differences while leaving completion and termination frozen',()=>{const p=projected();expect(observedTargetDelta(p,'2026-11-10T12:00:00Z').signedValue).toBe(120);expect(observedTargetDelta({...p,businessCompleted:true},'2026-11-10T12:00:00Z')).toBe(p.goalDelta);const stopped={...p,goalDelta:{...p.goalDelta,kind:'terminated' as const,signedValue:null}};expect(observedTargetDelta(stopped,'2026-11-12T12:00:00Z')).toBe(stopped.goalDelta);});
 it('uses the original Beijing date boundary instead of midnight instant lateness',()=>{const p=projected(),dated={...p,goalDelta:{...p.goalDelta,targetAt:'2026-11-10T16:00:00Z',targetPrecision:'date' as const,targetDate:'2026-11-10',unit:'day' as const}};expect(observedTargetDelta(dated,'2026-11-10T15:59:59Z').signedValue).toBe(0);expect(observedTargetDelta(dated,'2026-11-10T16:00:00Z').signedValue).toBe(1);});
 it('separates own adopted responsibility from exceeding B and never declares no responsibility without own evidence',()=>{const p=projected(scope('A'),'2026-11-10T12:00:00Z');expect(cockpitOwnStatus(node('A',p))).toMatchObject({text:'逾期（有责口径）'});expect(cockpitOwnStatus(node('A',{...p,ownSla:{...p.ownSla,state:'within'}}))).toMatchObject({text:'逾期（无责）'});expect(cockpitOwnStatus(node('A',{...p,ownSla:{...p.ownSla,state:'not_adopted'}}))).toMatchObject({text:'超目标·待核'});});
 it('displays exact perPO buffer including zero and preserves unknown without cross-scope credit',()=>{const result=evaluateFixedScheduleScope(scope('A'),'2026-11-10T10:00:00Z'),native={...result,completionEstimate:{kind:'conditional' as const,earliest:'2026-11-10T10:00:00Z',latest:'2026-11-10T10:00:00Z'}};expect(cockpitScopeProgress({...native,lagMinutes:{minimum:0,maximum:0}}).text).toBe('可用0分钟');expect(cockpitScopeProgress({...native,lagMinutes:{minimum:-120,maximum:-120}}).text).toBe('可用2小时');expect(cockpitScopeProgress({...native,state:'late',lagMinutes:{minimum:60,maximum:60}}).text).toBe('预测落后1小时');expect(cockpitScopeProgress({...native,state:'unknown',lagMinutes:null}).text).toBe('待核');});
 it('never labels frozen B as original task D in task or risk presentations',()=>{const value=node('A');value.expectedAt='2027-03-01T08:00:00Z';value.expectedKind='plan';value.expectedPrecision='instant';value.nativeTaskDeadline={at:'2026-11-10T10:00:00Z',precision:'instant'};value.records=[{domain:'task',id:value.instanceId,url:null,mode:'read',version:null,lineId:null}];expect(originalNodeDeadlineLabel(value)).toContain('2026/11/10');expect(originalNodeDeadlineLabel(value)).not.toContain('2027/3/1');delete value.nativeTaskDeadline;expect(originalNodeDeadlineLabel(value)).toContain('2026/11/10');delete value.fixedTargets![0]!.progress.ownSla.deadlineAt;expect(originalNodeDeadlineLabel(value)).toBe('原截止待核');});
 it('formats the one physical span, real zero and date intervals without inventing unknown elapsed time',()=>{expect(cockpitDuration(null)).toBe('—');expect(cockpitDuration(0)).toBe('0分钟');expect(cockpitDuration(1500)).toBe('1天1小时');expect(cockpitDurationRange({minimum:60,maximum:120})).toBe('1小时～2小时');});
});

it('Acceptance PR02 exposes per-PO own deadlines and does not substitute the task aggregate start for an unready PO',()=>{
 const value=node('A'),other=scope('B');other.facts.work!.ready={precision:'unknown'};other.facts.work!.clockStart={precision:'unknown'};other.facts.work!.notYetReady=true;
 value.fixedTargets!.push({scopeRef:'po:B',lineId:'B',progress:projected(other)});value.nativeTaskDeadline={at:'2026-11-10T09:00:00Z',precision:'instant'};
 expect(originalNodeDeadlineLabel(value)).toBe('各PO责任截止见节点');
 const html=renderToStaticMarkup(createElement(CockpitFixedTargetDates,{node:value,lines:[{id:'A',po:'TEST RED',color:'红',orderedQuantity:1},{id:'B',po:'TEST BLUE',color:'蓝',orderedQuantity:1}] as never}));
 expect(html).toContain('TEST RED');expect(html).toContain('TEST BLUE');expect(html.match(/责任截止/g)).toHaveLength(2);expect(html).toContain('责任计时未开始或待核');expect(html).toContain('2026-11-10T10:00:00.000Z');expect(html).not.toContain('2026-11-10T09:00:00Z');
});

it('Acceptance PR02 risk duration uses the known own-PO window instead of legacy target overdue seconds',()=>{
 const value=node('A',projected(scope('A'),'2026-11-10T11:00:00.000Z'));value.overdueSeconds=10*86400;value.expectedPrecision='date';value.expectedAt='2026-11-01';
 const other=node('B').fixedTargets![0]!;other.progress.ownSla={state:'unknown',deadlineAt:null,overdueMinutes:null,sourceRef:'TEST not ready'};value.fixedTargets!.push(other);
 expect(nodeOverdue(value,'2026-11-10T11:00:00.000Z')).toBe('逾期 1 小时');
});

it('Acceptance PR02 Review retains distinct native batch deadlines without borrowing another scope or aggregate task deadline',()=>{
 const input=scope('A'),start={precision:'instant' as const,at:'2026-11-10T08:00:00.000Z'};
 input.facts.work!.ownWindows=[
  {sourceRef:'TEST batch A1',started:start,completed:{precision:'unknown'},complete:false,deadline:'2026-11-10T09:00:00.000Z',warningAt:null,calendar:'continuous'},
  {sourceRef:'TEST batch A2',started:start,completed:{precision:'unknown'},complete:false,deadline:'2026-11-10T12:00:00.000Z',warningAt:null,calendar:'continuous'}
 ];
 const value=node('A',projected(input,'2026-11-10T10:00:00.000Z'));
 value.nativeWindows=input.facts.work!.ownWindows.map(window=>({evidence:window.sourceRef,scopeLabel:'PO A',startedAt:start.at,completedAt:null,complete:false,deadline:window.deadline,warningAt:null}));
 value.nativeTaskDeadline={at:'2026-11-10T08:30:00.000Z',precision:'instant'};
 expect(value.fixedTargets![0]!.progress.ownSla).toMatchObject({state:'overdue',deadlineAt:null});
 expect(originalNodeDeadlineLabel(value)).toBe('各批原截止见节点');
 const html=()=>renderToStaticMarkup(createElement(CockpitFixedTargetDates,{node:value}));
 expect(html()).toContain('各批原截止见节点');expect(html()).not.toContain('未开始或待核');
 value.fixedTargets![0]!.progress.ownSla={state:'unknown',deadlineAt:null,overdueMinutes:null,sourceRef:'TEST unready PO B'};
 expect(originalNodeDeadlineLabel(value)).toBe('责任计时未开始或待核');expect(html()).not.toContain('各批原截止见节点');expect(html()).not.toContain('08:30');
});

it('keeps unbounded forecast slack uncertain and separates a predicted gap from customer overdue',()=>{
 const native=evaluateFixedScheduleScope(scope('A'),'2026-11-10T10:00:00Z');
 expect(native.completionEstimate?.kind).toBe('lower_bound');
 for(const lag of [{minimum:0,maximum:0},{minimum:-120,maximum:-60}])expect(cockpitScopeProgress({...native,lagMinutes:lag})).toMatchObject({text:'进度待核',tone:'neutral'});
 expect(cockpitScopeProgress({...native,lagMinutes:{minimum:60,maximum:120},state:'late',customerDuePassed:false})).toMatchObject({text:'预测至少落后1小时',tone:'danger'});
 expect(cockpitScopeProgress({...native,completionEstimate:{kind:'actual',earliest:'2026-11-10T11:00:00Z',latest:'2026-11-10T11:00:00Z'},lagMinutes:{minimum:60,maximum:60}}).text).toBe('落后1小时');
});

it('keeps predicted progress warnings independent from the actual customer deadline status',()=>{
 const native=evaluateFixedScheduleScope(scope('A'),'2026-11-10T11:00:00Z');
 const order={lines:[{id:'A',po:'TEST-PO'}],display:{mainState:'active'},fixedSchedule:{state:'late',scopes:[{...native,state:'late',customerDuePassed:false}]}} as unknown as OrderJourney;
 expect(cockpitScheduleReason(order)).toEqual({text:'预测进度落后 · PO TEST-PO',tone:'warning'});
 order.fixedSchedule!.scopes[0]!.customerDuePassed=true;
 expect(cockpitScheduleReason(order)).toEqual({text:'交期已过 · PO TEST-PO',tone:'danger'});
});
