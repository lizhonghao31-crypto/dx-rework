import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {SlaAnchor,SlaTime} from '@dx-rework/domain/digital-sla-plan';
import {fixedTimelineForward,requiredFixedTimelineWork,type FixedTimelineTarget,type FixedTimelineWork} from './fixed-timeline-targets.js';
import type {OrderTimeInput,StoredOrderTimePlan} from './order-time-plan-repository.js';
import {orderTimeCompletionBound,type OrderTimeNativeProgress} from './order-time-request-plan.js';
import {buildOrderTimeWork} from './order-time-schedule.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import {arrangedOrderTimeTarget} from './framework-node-targets.js';

export type FormalRemainingInputs={
 version:'approved-remaining-v1';
 progress:Record<string,OrderTimeNativeProgress>;
 notBefore:Readonly<Record<string,SlaAnchor>>;
 pendingWork?:readonly string[];
};

const missing=(reason:string):SlaTime=>({at:null,exclusive:false,reasons:[reason]});
type Targets=Record<string,Record<string,FixedTimelineTarget>>;

function applicableWork(graph:readonly FixedTimelineWork[],terminals:readonly string[]){
 const required=requiredFixedTimelineWork(graph,terminals),ids=new Set(required.map(work=>work.id));
 return graph.filter(work=>ids.has(work.id)||work.includedIn&&ids.has(work.includedIn));
}

/** Another command can preserve a formal plan only for the same scope and
 * work graph. Changed graphs have no new P until formally adopted. */
export function retainFormalTargets(input:OrderTimeInput,previous:StoredOrderTimePlan):Targets|undefined{
 const prior=previous.input,priorTargets=prior.formalTargets;
 if(!priorTargets)return undefined;
 const graph=buildOrderTimeWork(input.plan,input.work),oldGraph=buildOrderTimeWork(prior.plan,prior.work);
 const definitions=new Map(input.work.map(work=>[work.id,work])),oldDefinitions=new Map(prior.work.map(work=>[work.id,work]));
 const identity=(work:FixedTimelineWork[],byId:typeof definitions)=>fixedTimelineIdentity([...work].sort((a,b)=>a.id.localeCompare(b.id,'en')).map(entry=>[entry,byId.get(entry.id)]));
 const entries=input.scopes.flatMap(scope=>{
  const old=prior.scopes.find(row=>row.scopeRef===scope.scopeRef&&row.lineId===scope.lineId),targets=priorTargets[scope.scopeRef];
  if(!old||!targets)return [];
  const same=fixedTimelineIdentity([...old.terminalIds].sort())===fixedTimelineIdentity([...scope.terminalIds].sort())
   &&identity(applicableWork(oldGraph,old.terminalIds),oldDefinitions)===identity(applicableWork(graph,scope.terminalIds),definitions);
  return [[scope.scopeRef,same?structuredClone(targets):{}] as const];
 });
 return entries.length?Object.fromEntries(entries):undefined;
}

/** Compute only the formally adopted remaining schedule. Scope goals are the
 * existing promises and evaluation targets; they are not remaining-work start
 * constraints. The immutable approval time is the floor for work not begun.
 */
export function formalRemainingSchedule(input:OrderTimeInput,snapshot:FormalRemainingInputs,previous:StoredOrderTimePlan,time:BusinessTime,eventRef:string){
 const graph=buildOrderTimeWork(input.plan,input.work),workById=new Map(input.work.map(work=>[work.id,work]));
 const priorWork=new Map(previous.input.work.map(work=>[work.canonicalWorkRef??work.id,work]));
 const now=Date.parse(time.now),pending=new Set(snapshot.pendingWork??[]),minimumStart:SlaAnchor={precision:'instant',value:time.now,source:eventRef};
 const targets:Targets={},terminalEnds:Record<string,SlaTime[]>={};
 const carried=retainFormalTargets(input,previous),priorSnapshot=previous.input.formalInputs;
 const constraintIdentity=(scopeRef:string,work:readonly FixedTimelineWork[],facts:FormalRemainingInputs)=>{
  const pending=new Set(facts.pendingWork??[]);
  return fixedTimelineIdentity(work.map(node=>{
   const source=workById.get(node.id)!,ref=source.canonicalWorkRef??source.id,scoped=`${scopeRef}|${ref}`;
   const key=Object.hasOwn(facts.progress,scoped)?scoped:ref;
   return [node.id,facts.progress[key]??null,pending.has(key),facts.notBefore[node.id]??null];
  }));
 };
 const unchanged=new Set(input.scopes.flatMap(scope=>{
  if(!priorSnapshot||!Object.keys(carried?.[scope.scopeRef]??{}).length)return [];
  const work=applicableWork(graph,scope.terminalIds);
  return constraintIdentity(scope.scopeRef,work,snapshot)===constraintIdentity(scope.scopeRef,work,priorSnapshot)?[scope.scopeRef]:[];
 }));
 // An explicit whole-order rearrangement can refresh all P. If only some
 // scopes changed, keep the untouched siblings at their adopted times.
 const scopedChange=unchanged.size>0&&unchanged.size<input.scopes.length;
 for(const scope of input.scopes){
  const applicable=applicableWork(graph,scope.terminalIds);
  const retained:Record<string,FixedTimelineTarget>={},completions:Record<string,SlaTime>={};
  for(const node of applicable){
   if(node.includedIn)continue;
   const work=workById.get(node.id)!,ref=work.canonicalWorkRef??work.id;
   const scoped=`${scope.scopeRef}|${ref}`,key=Object.hasOwn(snapshot.progress,scoped)?scoped:ref;
   const observed=snapshot.progress[key];
   // A registration can start responsibility while the native task has yet
   // to be assigned or begun. Its original R/D stay outside this solver.
   if(!observed||!observed.completed&&(!observed.readyAt||pending.has(key)))continue;
   const prior=priorWork.get(ref),target=prior?arrangedOrderTimeTarget(previous,scope.scopeRef,prior.id):undefined;
   const unknown=missing('已开始工作缺少原正式安排');
   retained[node.id]=target?{...target,id:node.id}:{id:node.id,start:unknown,end:unknown};
   if(observed.completed){
    if(observed.actualAt&&Date.parse(observed.actualAt)>now||observed.actualDate&&Date.parse(observed.actualDate+'T00:00:00+08:00')>now){
     completions[node.id]=missing('前序实际完成晚于本次安排生效');
    }else completions[node.id]=orderTimeCompletionBound(observed,time.now);
   }else{
    const ready=Date.parse(observed.readyAt!),deadline=observed.deadline,finish=deadline?Date.parse(deadline):NaN;
    // Preserve this work's original P. Its successor uses the trusted open
    // responsibility window as a candidate handoff, separate from old P/B.
    completions[node.id]=deadline&&ready<=now&&finish>=now&&!observed.unresolvedOverrun
     ?{at:deadline,exclusive:false,reasons:[]}:missing('在办前序已超原责任窗口或缺少可信候选完成时间');
   }
  }
  const byId=scopedChange&&unchanged.has(scope.scopeRef)?carried![scope.scopeRef]!
   :Object.fromEntries(fixedTimelineForward(applicable,minimumStart,snapshot.notBefore,{minimumStart,retained,completions}).map(row=>[row.id,row]));
  targets[scope.scopeRef]=byId;
  // A retained target is history. Compare a terminal's true completion or
  // current handoff when it has begun, and the formal scheduled end otherwise.
  terminalEnds[scope.scopeRef]=scope.terminalIds.map(id=>completions[id]??byId[id]?.end??missing('本范围正式安排终点尚未核实'));
 }
 return {targets,terminalEnds};
}
