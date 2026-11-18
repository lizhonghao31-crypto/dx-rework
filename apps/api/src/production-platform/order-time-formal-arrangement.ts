import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {SlaAnchor,SlaTime} from '@dx-rework/domain/digital-sla-plan';
import {fixedTimelineForward,requiredFixedTimelineWork,type FixedTimelineTarget} from './fixed-timeline-targets.js';
import type {OrderTimeInput,StoredOrderTimePlan} from './order-time-plan-repository.js';
import {orderTimeCompletionBound,type OrderTimeNativeProgress} from './order-time-request-plan.js';
import {buildOrderTimeWork} from './order-time-schedule.js';

export type FormalRemainingInputs={
 version:'approved-remaining-v1';
 progress:Record<string,OrderTimeNativeProgress>;
 notBefore:Readonly<Record<string,SlaAnchor>>;
 pendingWork?:readonly string[];
};

const missing=(reason:string):SlaTime=>({at:null,exclusive:false,reasons:[reason]});

/** Compute only the formally adopted remaining schedule. Scope goals are the
 * existing promises and evaluation targets; they are not remaining-work start
 * constraints. The immutable approval time is the floor for work not begun.
 */
export function formalRemainingTargets(input:OrderTimeInput,snapshot:FormalRemainingInputs,previous:StoredOrderTimePlan,time:BusinessTime,eventRef:string):Record<string,Record<string,FixedTimelineTarget>>{
 const graph=buildOrderTimeWork(input.plan,input.work),workById=new Map(input.work.map(work=>[work.id,work]));
 const priorWork=new Map(previous.input.work.map(work=>[work.canonicalWorkRef??work.id,work]));
 const now=Date.parse(time.now),pending=new Set(snapshot.pendingWork??[]),minimumStart:SlaAnchor={precision:'instant',value:time.now,source:eventRef};
 return Object.fromEntries(input.scopes.map(scope=>{
  const required=requiredFixedTimelineWork(graph,scope.terminalIds),ids=new Set(required.map(work=>work.id));
  const applicable=graph.filter(work=>ids.has(work.id)||work.includedIn&&ids.has(work.includedIn));
  const retained:Record<string,FixedTimelineTarget>={},completions:Record<string,SlaTime>={};
  for(const node of required){
   const work=workById.get(node.id)!,ref=work.canonicalWorkRef??work.id;
   const scoped=`${scope.scopeRef}|${ref}`,key=Object.hasOwn(snapshot.progress,scoped)?scoped:ref;
   const observed=snapshot.progress[key];
   // A registration can start responsibility while the native task has yet
   // to be assigned or begun. Its original R/D stay outside this solver.
   if(!observed||!observed.completed&&(!observed.readyAt||pending.has(key)))continue;
   const prior=priorWork.get(ref),target=prior?(previous.input.formalTargets?.[scope.scopeRef]??previous.targets[scope.scopeRef])?.[prior.id]:undefined;
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
  const targets=fixedTimelineForward(applicable,minimumStart,snapshot.notBefore,{minimumStart,retained,completions});
  return [scope.scopeRef,Object.fromEntries(targets.map(row=>[row.id,row]))];
 }));
}
