import type {JourneyTimeFramework} from '@dx-rework/contracts/time-framework-journey';
import type {SeriesMilestoneKey,SeriesRoute} from '@dx-rework/contracts/digital-series-plan';
import type {ScheduleOccurrence,ScheduleScopeProgress} from '@dx-rework/contracts';
import type {StoredOrderTimePlan} from './order-time-plan-repository.js';
import type {OrderTimePolicyVersion} from './order-time-native-timing.js';
import {fixedGoalDelta,scheduleOccurrenceBounds,type ScheduleScopeInput,type ScheduleWork,type ScheduleTermination} from './fixed-schedule-progress.js';

type MilestoneBasis={key:SeriesMilestoneKey;date:string;at:string|null;plannedAt:string|null;workIds:string[];relatedWorkIds?:string[];completionTarget?:ScheduleWork['completionTarget']};
export type JourneyFrameworkBasis=Array<{scopeRef:string;lineId:string|null;route:SeriesRoute;reference:string;revision:number;effectiveAt:string;customerDate:string;milestones:MilestoneBasis[]}>;
const unknown:ScheduleOccurrence={precision:'unknown'};
/** A whole required set must finish. Unknown timestamps are not sorted last
 * and silently ignored; a date is never promoted to an exact midnight. */
export function frameworkCompletion(scope:ScheduleScopeInput,ids:readonly string[],asOf:string){
 const facts=ids.map(id=>scope.facts[id]);const completed=ids.length>0&&facts.every(f=>f?.businessCompleted);
 if(!completed)return {completed:false,actual:unknown};
 const bounds=facts.map(f=>scheduleOccurrenceBounds(f!.completed,asOf));
 if(bounds.some(b=>!b))return {completed:true,actual:unknown};
 if(facts.every(f=>f!.completed.precision==='instant'))return {completed:true,actual:{precision:'instant' as const,at:new Date(Math.max(...bounds.map(b=>b![0]))).toISOString()}};
 const dates=bounds.map(b=>new Date(b![0]+8*3600000).toISOString().slice(0,10));
 return {completed:true,actual:{precision:'date' as const,date:dates.sort().at(-1)!}};
}
export function frameworkJourneyBasis(saved:StoredOrderTimePlan,scopes:readonly ScheduleScopeInput[],history:readonly OrderTimePolicyVersion[],asOf:string):JourneyFrameworkBasis|undefined{
 if(!saved.input.frameworkPlans)return undefined;
 return scopes.flatMap(scope=>{const plan=saved.input.frameworkPlans![scope.scopeRef];if(!plan)return [];
  const milestoneEnds=new Set(plan.milestones.flatMap(row=>row.workIds));
  const related=(ends:string[])=>{const selected=new Set<string>(),byId=new Map(scope.work.map(work=>[work.id,work]));const visit=(id:string,root=false)=>{if(selected.has(id))return;selected.add(id);if(!root&&milestoneEnds.has(id))return;for(const dependency of byId.get(id)?.dependsOn??[])visit(dependency);};for(const end of ends)visit(end,true);for(const work of scope.work)if(work.includedIn&&selected.has(work.includedIn))selected.add(work.id);return [...selected];};
  return [{scopeRef:scope.scopeRef,lineId:scope.lineId,route:plan.input.route,reference:plan.reference,revision:plan.revision,effectiveAt:plan.effectiveAt,customerDate:plan.input.customerDelivery.date,
   milestones:plan.milestones.map(m=>{
    const completion=frameworkCompletion(scope,m.workIds,asOf);let completionTarget:ScheduleWork['completionTarget'];
    if(completion.completed){completionTarget=null;const bounds=scheduleOccurrenceBounds(completion.actual,asOf);
     if(bounds){const versions=history.filter(v=>v.history?.time.scenarioId===saved.time.scenarioId).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
      const changedDuring=versions.some(v=>Date.parse(v.at)>bounds[0]&&Date.parse(v.at)<=bounds[1]);
      const old=versions.find(v=>Date.parse(v.at)<=bounds[0]),prior=old?.history?.input.frameworkPlans?.[scope.scopeRef]?.milestones.find(row=>row.key===m.key);
      if(!changedDuring&&prior?.target.at&&prior.workIds.length===m.workIds.length&&prior.workIds.every(id=>m.workIds.includes(id)))completionTarget={end:prior.target.at,targetRevision:old!.id+':'+old!.history!.revision,targetPrecision:'date',targetDate:prior.date};
     }
    }
    return {key:m.key,date:m.date,at:m.target.at,plannedAt:m.planned.at,workIds:[...m.workIds],relatedWorkIds:related(m.workIds),...(completionTarget!==undefined?{completionTarget}:{})};
   })}];
 });
}
export function evaluateJourneyFramework(basis:JourneyFrameworkBasis,scopes:readonly ScheduleScopeInput[],progress:readonly ScheduleScopeProgress[],asOf:string,termination:ScheduleTermination|null):JourneyTimeFramework{
 const unique=new Map<string,boolean>();
 const output=basis.map(row=>{const scope=scopes.find(s=>s.scopeRef===row.scopeRef)!,result=progress.find(s=>s.scopeRef===row.scopeRef)!;
  for(const work of scope.work){if(work.includedIn||work.accountingRole==='event')continue;const key=work.canonicalWorkRef;unique.set(key,(unique.get(key)??true)&&scope.facts[work.id]?.businessCompleted===true);}
  return {...row,milestones:row.milestones.map(m=>{
   const completion=frameworkCompletion(scope,m.workIds,asOf),nodes=m.workIds.map(id=>result.nodes.find(n=>n.id===id));
   const work:ScheduleWork={id:m.key,canonicalWorkRef:m.key,dependsOn:[],start:null,end:m.at,minutes:0,calendar:'continuous',responsibilitySlaRef:null,targetPrecision:'date',targetDate:m.date,...(m.completionTarget!==undefined?{completionTarget:m.completionTarget}:{})};
   const delta=fixedGoalDelta(work,{ready:unknown,clockStart:unknown,completed:completion.actual,businessCompleted:completion.completed,waitingForPredecessors:false,evidenceRefs:[]},scope,asOf,termination);
   const known=nodes.length>0&&nodes.every(n=>n?.availabilityBound),lower=nodes.some(n=>n?.estimateKind==='lower_bound');
   const latest=known?new Date(Math.max(...nodes.map(n=>Date.parse(n!.availabilityBound!.latest)))).toISOString():null;
   const earliest=known?new Date(Math.max(...nodes.map(n=>Date.parse(n!.availabilityBound!.earliest)))).toISOString():null;
   const forecast={kind:termination&&!completion.completed?'terminated' as const:!known?'unknown' as const:completion.completed?'actual' as const:lower?'lower_bound' as const:'conditional' as const,earliest:termination&&!completion.completed?null:earliest,latest:termination&&!completion.completed||lower?null:latest};
   const knownBounds=nodes.flatMap(n=>n?.availabilityBound?[n.availabilityBound]:[]),knownEnds=knownBounds.map(bound=>Date.parse(bound.earliest)),target=m.at?Date.parse(m.at):null;
   // A known late branch remains a proved gap even if its sibling is unknown.
   // The date's following midnight is exclusive, not an on-time instant.
   const late=target===null?[]:knownBounds.filter(bound=>Date.parse(bound.earliest)>target||Date.parse(bound.earliest)===target&&!bound.exclusive).map(bound=>Date.parse(bound.earliest)),stopped=Boolean(termination&&!completion.completed);
   const latestKnownEnd=knownEnds.length?Math.max(...knownEnds):null;
   const gap=target===null||latestKnownEnd===null?null:Math.max(0,(latestKnownEnd-target+(latestKnownEnd===target&&late.length?1:0))/60000);
   const sufficient=target!==null&&forecast.latest!==null&&(Date.parse(forecast.latest)<target||Date.parse(forecast.latest)===target&&knownBounds.every(bound=>Date.parse(bound.latest)<target||bound.exclusive===true));
   const feasibility=stopped?'terminated' as const:late.length?'insufficient' as const:sufficient?'sufficient' as const:'unknown' as const;
   return {key:m.key,targetDate:m.date,plannedAt:m.plannedAt,workIds:[...m.workIds],...(m.relatedWorkIds?{relatedWorkIds:[...m.relatedWorkIds]}:{}),...completion,delta,forecast,feasibility,lateMinutes:feasibility==='insufficient'?gap:feasibility==='sufficient'?0:null,coverage:[...new Set(nodes.flatMap(n=>n?.coverage??['里程碑关联工作待核']))]};
  })};
 });
 const completedWork=[...unique.values()].filter(Boolean).length;
 return {version:'journey-time-framework-v1',asOf,scopes:output,applicableWork:unique.size,completedWork};
}
