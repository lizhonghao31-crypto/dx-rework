import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import {orderTimeNodeStage} from '@dx-rework/contracts/order-time-settings';
import type {ScheduleOccurrence,ScheduleStageProgress} from '@dx-rework/contracts';
import type {FixedScheduleBasis} from './fixed-schedule-basis.js';
import {fixedDurationSummary,fixedGoalDelta,type ScheduleScopeInput,type ScheduleWork} from './fixed-schedule-progress.js';

const unknown:ScheduleOccurrence={precision:'unknown'};
function stageNumber(work:ScheduleWork){
 const key=(work.id.startsWith('source:')?work.id.slice(7):work.id).split(':')[0]!;
 return orderTimeNodeStage(key,work.stage??0)||null;
}

/** A stage's displayed B and delta use that same stage endpoint. They never
 * combine max(B) with the worst unrelated child's delay. PO scopes still keep
 * their own risks; this is the whole-stage date, not cross-PO compensation. */
export function fixedScheduleStages(basis:FixedScheduleBasis,asOf:string):ScheduleStageProgress[]{
 return JOURNEY_STAGES.flatMap((_,index)=>{
  const stage=index+1,scopes:ScheduleScopeInput[]=basis.scopes.flatMap(scope=>{
   const selected=scope.work.filter(work=>stageNumber(work)===stage&&!scope.facts[work.id]?.terminated);
   if(!selected.length)return [];
   const ids=new Set(selected.map(work=>work.id)),work=selected.map(work=>({...work,dependsOn:work.dependsOn.filter(id=>ids.has(id))}));
   const terminalIds=work.filter(node=>!node.includedIn&&!work.some(other=>other.dependsOn.includes(node.id))).map(node=>node.id);
   return [{...scope,work,terminalIds,customerGoal:null}];
  });
  if(!scopes.length)return [];
  const all=scopes.flatMap(scope=>scope.work.filter(work=>!work.includedIn)),targets=all.map(work=>work.end),known=targets.length&&targets.every((at):at is string=>at!==null);
  const end=known?all.reduce((latest,work)=>Date.parse(work.end!)>Date.parse(latest.end!)?work:latest):null;
  const summary=fixedDurationSummary(scopes,asOf,basis.termination),complete=scopes.every(scope=>scope.work.filter(work=>!work.includedIn).every(work=>scope.facts[work.id]?.businessCompleted));
  const actual=complete?summary.deliveryCompletedAt:unknown;
  const expected:ScheduleOccurrence=!end?unknown:end.targetPrecision==='date'&&end.targetDate?{precision:'date',date:end.targetDate}:{precision:'instant',at:end.end!};
  const scope={scopeRef:`stage:${stage}`,targetRevision:basis.scopeRevision};
  const historical=complete&&all.some(work=>work.completionTarget!==undefined);
  const completedTargets=all.map(work=>work.completionTarget);
  const completionTarget=historical&&completedTargets.every((target):target is NonNullable<ScheduleWork['completionTarget']>=>Boolean(target))?completedTargets.reduce((latest,target)=>Date.parse(target.end)>Date.parse(latest.end)?target:latest):null;
  const goalDelta=fixedGoalDelta({id:scope.scopeRef,canonicalWorkRef:scope.scopeRef,dependsOn:[],start:summary.planStart,end:end?.end??null,minutes:0,calendar:'continuous',responsibilitySlaRef:null,...(historical?{completionTarget}:{}),...(end?.targetPrecision?{targetPrecision:end.targetPrecision}:{}),...(end?.targetDate?{targetDate:end.targetDate}:{})},
   {ready:summary.actualStart,clockStart:summary.actualStart,completed:actual,businessCompleted:complete,waitingForPredecessors:false,evidenceRefs:[]},scope,asOf,basis.termination);
  return [{stage,startedAt:summary.actualStart,expected,actual,goalDelta}];
 });
}
