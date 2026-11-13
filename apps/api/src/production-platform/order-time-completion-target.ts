import type {ScheduleOccurrence} from '@dx-rework/contracts';
import type {OrderTimeWork} from './order-time-schedule.js';
import type {OrderTimePolicyVersion} from './order-time-native-timing.js';
import type {ScheduleWork} from './fixed-schedule-progress.js';

export type InheritedOrderTimeHistory={sourceId:string;versions:readonly OrderTimePolicyVersion[]};
export function isInheritedSourceWork(work:OrderTimeWork,sourceId:string):boolean{
 return Boolean(work.canonicalWorkRef?.startsWith(`source:${sourceId}:round:`)||work.canonicalWorkRef===`creation:source:${sourceId}`);
}
const ordered=(versions:readonly OrderTimePolicyVersion[],scenarioId:string|null)=>versions.filter(version=>version.history&&version.history.time.scenarioId===scenarioId).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||b.history!.revision-a.history!.revision);
function matchingWork(work:OrderTimeWork,version:OrderTimePolicyVersion){
 const matches=version.history!.input.work.filter(row=>row.parameterKey===work.parameterKey&&(work.canonicalWorkRef?row.canonicalWorkRef===work.canonicalWorkRef:row.id===work.id));
 return matches.length===1?matches[0]!:null;
}
function sourceScopes(work:OrderTimeWork,version:OrderTimePolicyVersion){
 const node=matchingWork(work,version);return node?version.history!.input.scopes.filter(scope=>scope.lineId===null&&version.history!.targets[scope.scopeRef]?.[node.id]):[];
}
/** Only the explicitly linked source and exact original work/round can supply
 * a pre-conversion policy. Never fall back by label or another PO's target. */
export function inheritedSourcePolicyAt(work:OrderTimeWork,inherited:InheritedOrderTimeHistory|undefined,at:string,scenarioId:string|null):OrderTimePolicyVersion|undefined{
 if(!inherited||!isInheritedSourceWork(work,inherited.sourceId))return undefined;
 const chosen=ordered(inherited.versions,scenarioId).find(version=>Date.parse(version.at)<=Date.parse(at));
 return chosen&&sourceScopes(work,chosen).length===1?chosen:undefined;
}
/** Resolve by physical occurrence, not when it was entered or when GET runs.
 * A date spanning a version change has no provable single target. */
export function orderTimeCompletionTarget(work:OrderTimeWork,scope:{scopeRef:string;lineId:string|null},actual:ScheduleOccurrence,versions:readonly OrderTimePolicyVersion[],scenarioId:string|null,inherited?:InheritedOrderTimeHistory):NonNullable<ScheduleWork['completionTarget']>|null{
 if(actual.precision==='unknown')return null;
 const start=Date.parse(actual.precision==='instant'?actual.at:actual.date+'T00:00:00+08:00'),end=actual.precision==='instant'?start:start+86400000-1;
 if(!Number.isFinite(start))return null;
 let applicable=ordered(versions,scenarioId),chosen=applicable.find(version=>Date.parse(version.at)<=start),originalScope=scope;
 if(applicable.some(version=>Date.parse(version.at)>start&&Date.parse(version.at)<=end))return null;
 if(!chosen){
  // The formal plan did not exist at completion. Its later retained target is
  // not the proof: read the linked source's then-effective original scope.
  chosen=inheritedSourcePolicyAt(work,inherited,new Date(start).toISOString(),scenarioId);
  if(!chosen)return null;
  applicable=ordered(inherited!.versions,scenarioId);
  if(applicable.some(version=>Date.parse(version.at)>start&&Date.parse(version.at)<=end))return null;
  originalScope=sourceScopes(work,chosen)[0]!;
 }
 const old=chosen.history!,oldScope=old.input.scopes.find(row=>row.scopeRef===originalScope.scopeRef&&row.lineId===originalScope.lineId),node=matchingWork(work,chosen);
 if(!oldScope||!node)return null;
 const target=old.targets[oldScope.scopeRef]?.[node.id],goal=oldScope.customerGoalIds.includes(node.id)?oldScope.goals[node.id]:null;
 if(!target?.end.at)return null;
 return {end:target.end.at,targetRevision:`${chosen.id}:${old.revision}`,targetPrecision:goal?.precision==='date'?'date':'instant',targetDate:goal?.precision==='date'?goal.value:null};
}
