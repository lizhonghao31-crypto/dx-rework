import type {ScheduleOccurrence} from '@dx-rework/contracts';
import type {OrderTimeWork} from './order-time-schedule.js';
import type {OrderTimePolicyVersion} from './order-time-native-timing.js';
import type {ScheduleWork} from './fixed-schedule-progress.js';

/** Resolve by physical occurrence, not when it was entered or when GET runs.
 * A date spanning a version change has no provable single target. */
export function orderTimeCompletionTarget(work:OrderTimeWork,scope:{scopeRef:string;lineId:string|null},actual:ScheduleOccurrence,versions:readonly OrderTimePolicyVersion[],scenarioId:string|null):NonNullable<ScheduleWork['completionTarget']>|null{
 if(actual.precision==='unknown')return null;
 const start=Date.parse(actual.precision==='instant'?actual.at:actual.date+'T00:00:00+08:00'),end=actual.precision==='instant'?start:start+86400000-1;
 if(!Number.isFinite(start))return null;
 const applicable=versions.filter(version=>version.history&&version.history.time.scenarioId===scenarioId).sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||b.history!.revision-a.history!.revision);
 const chosen=applicable.find(version=>Date.parse(version.at)<=start);
 if(!chosen||applicable.some(version=>Date.parse(version.at)>start&&Date.parse(version.at)<=end))return null;
 const old=chosen.history!,oldScope=old.input.scopes.find(row=>row.scopeRef===scope.scopeRef&&row.lineId===scope.lineId);
 const matches=old.input.work.filter(row=>work.canonicalWorkRef?row.canonicalWorkRef===work.canonicalWorkRef:row.id===work.id&&row.parameterKey===work.parameterKey);
 if(!oldScope||matches.length!==1)return null;
 const node=matches[0]!,target=old.targets[oldScope.scopeRef]?.[node.id],goal=oldScope.customerGoalIds.includes(node.id)?oldScope.goals[node.id]:null;
 if(!target?.end.at)return null;
 return {end:target.end.at,targetRevision:`${chosen.id}:${old.revision}`,targetPrecision:goal?.precision==='date'?'date':'instant',targetDate:goal?.precision==='date'?goal.value:null};
}
