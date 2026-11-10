import type {FixedScheduleCalendar,ScheduleOccurrence,ScheduleRange,ScheduleGoalDelta,ScheduleNodeProgress,ScheduleScopeProgress,ScheduleDurationSummary} from '@dx-rework/contracts';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';

export type ScheduleWork={id:string;canonicalWorkRef:string;dependsOn:readonly string[];start:string|null;end:string|null;minutes:number|null;calendar:FixedScheduleCalendar|null;includedIn?:string;accountingRole?:'original_work'|'added_work'|'included'|'event'|'shared_reference';originalHandoffAt?:string|null;responsibilitySlaRef:string|null;responsibilityMinutes?:number|null;responsibilityCalendar?:FixedScheduleCalendar|null;targetPrecision?:'instant'|'date';targetDate?:string|null;targetRevision?:string};
export type ScheduleFact={ready:ScheduleOccurrence;completed:ScheduleOccurrence;businessCompleted:boolean;waitingForPredecessors:boolean;clockStart:ScheduleOccurrence;evidenceRefs:readonly string[];impactStartedAt?:string|null;terminated?:boolean};
export type ScheduleScopeInput={scopeRef:string;lineId:string|null;targetRevision:string;work:readonly ScheduleWork[];facts:Readonly<Record<string,ScheduleFact>>;terminalIds:readonly string[];customerGoal:string|null};
export type ScheduleTermination={at:string|null;kind:'cancelled'|'special_closure'};
type Interval=readonly[number,number];
type Boundary={available:Interval;credit:Interval;reference:number;completed:boolean};
const MINUTE=60000,DAY=86400000,OFFSET=8*60*MINUTE;
const iso=(value:number)=>new Date(value).toISOString();
const timestamp=(value:string|null|undefined)=>value&&Number.isFinite(Date.parse(value))?Date.parse(value):null;
const dateOf=(value:number)=>new Date(value+OFFSET).toISOString().slice(0,10);
const dateInterval=(date:string):Interval|null=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(date))return null;const start=Date.parse(date+'T00:00:00+08:00');return Number.isFinite(start)&&dateOf(start)===date?[start,start+DAY-1]:null;};
/** Internal interval endpoints are bounds, never exposed as actual instants. */
export function scheduleOccurrenceBounds(value:ScheduleOccurrence,asOf:string):Interval|null{
 const now=timestamp(asOf);if(now===null)return null;
 if(value.precision==='unknown')return null;
 if(value.precision==='instant'){const at=timestamp(value.at);return at!==null&&at<=now?[at,at]:null;}
 const range=dateInterval(value.date);return range&&range[0]<=now?range:null;
}
function completedBounds(fact:ScheduleFact|undefined,asOf:string):Interval|null{
 if(!fact?.businessCompleted)return null;
 const actual=scheduleOccurrenceBounds(fact.completed,asOf);if(!actual)return null;
 const starts=[fact.ready,fact.clockStart].map(value=>value.precision==='date'?dateInterval(value.date):value.precision==='instant'?timestamp(value.at)===null?null:[timestamp(value.at)!,timestamp(value.at)!] as const:null);
 return starts.some(start=>start&&actual[1]<start[0])?null:actual;
}
/** Signed minutes on the adopted clock; comparisons and zero movement preserve
 * physical Sunday instants instead of normalizing them to Monday. */
export function scheduleElapsed(from:number,to:number,calendar:FixedScheduleCalendar):number{
 if(from===to)return 0;if(to<from)return -scheduleElapsed(to,from,calendar);
 if(calendar!=='beijing_sunday_excluded')return (to-from)/MINUTE;
 let total=0,at=from;
 while(at<to){const day=new Date(at+OFFSET),end=Date.UTC(day.getUTCFullYear(),day.getUTCMonth(),day.getUTCDate()+1)-OFFSET,next=Math.min(end,to);if(day.getUTCDay()!==0)total+=next-at;at=next;}
 return total/MINUTE;
}
const shift=(at:number,minutes:number,calendar:FixedScheduleCalendar)=>minutes===0?at:Date.parse(shiftFixedTimeline(iso(at),minutes,calendar));
const range=(minimum:number,maximum:number):ScheduleRange=>({minimum,maximum});
const state=(lag:ScheduleRange|null)=>!lag?'unknown' as const:lag.minimum>0?'late' as const:lag.maximum<=0?'normal' as const:'unknown' as const;
const unknown:ScheduleOccurrence={precision:'unknown'};

export function fixedGoalDelta(work:ScheduleWork,fact:ScheduleFact|undefined,scope:Pick<ScheduleScopeInput,'scopeRef'|'targetRevision'>,asOf:string,termination?:ScheduleTermination|null):ScheduleGoalDelta{
 const result:ScheduleGoalDelta={kind:'unknown',signedValue:null,unit:work.targetPrecision==='date'?'day':'minute',asOf,targetAt:work.end,targetPrecision:work.targetPrecision??'instant',targetDate:work.targetDate??null,actual:fact?.completed??unknown,targetRevision:work.targetRevision??scope.targetRevision,scopeRef:scope.scopeRef};
 if(!fact?.businessCompleted&&(termination||fact?.terminated))return {...result,kind:'terminated'};
 const end=timestamp(work.end),now=timestamp(asOf);if(end===null||now===null)return result;
 if(work.targetPrecision==='date'){
  if(!work.targetDate)return result;
  const target=dateInterval(work.targetDate);if(!target)return result;
  const actual=fact?.businessCompleted?fact.completed:null;
  if(actual?.precision==='unknown')return result;
  const bounds=actual?completedBounds(fact,asOf):[now,now] as const;if(!bounds)return result;
  const day=dateOf(bounds[0]),difference=(Date.parse(day)-Date.parse(work.targetDate))/DAY;
  const value=actual?difference:Math.max(0,difference);
  return {...result,signedValue:value,kind:value>0?'late':value<0?'early':'on_target'};
 }
 if(!fact?.businessCompleted){const value=Math.max(0,(now-end)/MINUTE);return {...result,signedValue:value,kind:value>0?'late':'on_target'};}
 const actual=completedBounds(fact,asOf);if(!actual||actual[0]!==actual[1])return result;
 const value=(actual[0]-end)/MINUTE;return {...result,signedValue:value,kind:value>0?'late':value<0?'early':'on_target'};
}

/** One DAG evaluation per scope. Completed facts replace estimates; pending
 * descendants keep their entire adopted budget and never each consume now.
 * Availability and spendable credit remain distinct across calendars/joins. */
export function evaluateFixedScheduleScope(input:ScheduleScopeInput,asOf:string,termination?:ScheduleTermination|null):ScheduleScopeProgress{
 const now=timestamp(asOf);if(now===null)throw Error('进度观察时间无效');
 const works=new Map(input.work.map(work=>[work.id,work]));if(works.size!==input.work.length)throw Error('进度工作身份重复');
 const boundaries=new Map<string,Boundary|null>(),results=new Map<string,ScheduleNodeProgress>(),visiting=new Set<string>();
 const evaluate=(id:string):Boundary|null=>{
  if(boundaries.has(id))return boundaries.get(id)!;
  const work=works.get(id);if(!work)throw Error('进度缺少原依赖工作');if(visiting.has(id))throw Error('进度依赖成环');visiting.add(id);
  const fact=input.facts[id],coverage:string[]=[],added=work.accountingRole==='added_work',budget=added?0:work.minutes,start=timestamp(added?work.originalHandoffAt:work.start),end=timestamp(added?work.originalHandoffAt:work.end),calendar=work.calendar??(budget===0?'continuous':null);
  const completed=fact?.businessCompleted===true,actual=completedBounds(fact,asOf);
  const terminated=!completed&&Boolean(termination||fact?.terminated);
  const deps=work.dependsOn.map(evaluate);
  const goalDelta=fixedGoalDelta(work,fact,input,asOf,termination);
  let boundary:Boundary|null=null;
  if(work.accountingRole==='added_work'&&timestamp(work.originalHandoffAt)===null)coverage.push('新增范围缺少原交接目标');
  else if(completed&&actual&&end!==null)boundary={available:actual,credit:actual,reference:work.accountingRole==='added_work'?timestamp(work.originalHandoffAt)??end:end,completed:true};
  else if(completed)coverage.push('已完成但实际发生时间待核');
  else if(terminated)coverage.push('已终止');
  else if(start===null||end===null||budget===null||budget<0||!calendar)coverage.push('本范围冻结目标、规划时长或日历待核');
  else if(work.includedIn){boundary=evaluate(work.includedIn);}
  else if(deps.some(dep=>!dep))coverage.push('必要前序可交时间待核');
  else {
   const ready=fact?scheduleOccurrenceBounds(fact.ready,asOf):null;
   const allComplete=deps.every(dep=>dep!.completed);
   if(!ready&&work.accountingRole!=='added_work'&&!(deps.length&&!allComplete&&fact?.waitingForPredecessors))coverage.push('真实就绪或未完成前置依据待核');
   else {
    const available:number[]=[],credit:number[]=[];
    for(const side of [0,1] as const){
     const candidates=deps.map(dep=>dep!.completed?dep!.available[side]:Math.max(dep!.available[side],shift(start,Math.min(0,scheduleElapsed(dep!.reference,dep!.credit[side],calendar)),calendar)));
     const join=candidates.length?Math.max(...candidates):start;
     const joinCredit=allComplete&&deps.length?join:shift(start,Math.min(0,scheduleElapsed(start,join,calendar)),calendar);
     const position=Math.max(join,shift(start,Math.min(0,scheduleElapsed(start,joinCredit,calendar)),calendar),ready?.[side]??-Infinity);
     if(work.accountingRole==='added_work'){
      const impact=timestamp(fact?.impactStartedAt),active=impact!==null&&impact<=now;
      available.push(active?Math.max(join,now):join);credit.push(active?Math.max(joinCredit,now):joinCredit);
     }else{
      const quota=shift(position,budget!,calendar),bound=ready?Math.max(quota,now):quota;
      available.push(bound);credit.push(shift(end,Math.min(0,scheduleElapsed(end,bound,calendar)),calendar));
     }
    }
    boundary={available:[available[0]!,available[1]!],credit:[credit[0]!,credit[1]!],reference:work.accountingRole==='added_work'?timestamp(work.originalHandoffAt)??end:end,completed:false};
   }
  }
  const lag=boundary&&end!==null&&calendar?range(scheduleElapsed(end,boundary.available[0],calendar),scheduleElapsed(end,boundary.available[1],calendar)):null;
  const stop=terminated?timestamp(termination?.at):null;
  const ownCalendar=work.responsibilityCalendar,ownStart=fact?scheduleOccurrenceBounds(fact.clockStart,asOf):null,ownEnd=completed?actual:terminated?stop!==null&&stop<=now?[stop,stop] as const:null:[now,now] as const;
  const ownKnown=Boolean(work.responsibilitySlaRef&&work.responsibilityMinutes!==null&&work.responsibilityMinutes!==undefined&&ownCalendar&&ownStart&&ownEnd&&ownEnd[1]>=ownStart[0]);
  const own=ownKnown?range(Math.max(0,scheduleElapsed(ownStart![1],ownEnd![0],ownCalendar!)-work.responsibilityMinutes!),Math.max(0,scheduleElapsed(ownStart![0],ownEnd![1],ownCalendar!)-work.responsibilityMinutes!)):null;
  const ownState=!work.responsibilitySlaRef?'not_adopted':terminated?'terminated':!own?'unknown':own.minimum>0?'overdue':own.maximum===0?'within':'unknown';
  results.set(id,{id,scopeRef:input.scopeRef,targetRevision:work.targetRevision??input.targetRevision,canonicalWorkRef:work.canonicalWorkRef,state:terminated?'terminated':state(lag),lagMinutes:lag,businessCompleted:completed,availabilityBound:boundary?{earliest:iso(boundary.available[0]),latest:iso(boundary.available[1])}:null,creditLimit:boundary?{earliest:iso(boundary.credit[0]),latest:iso(boundary.credit[1])}:null,goalDelta,ownSla:{state:ownState,overdueMinutes:own,sourceRef:work.responsibilitySlaRef},coverage});
  visiting.delete(id);boundaries.set(id,boundary);return boundary;
 };
 for(const work of input.work)evaluate(work.id);
 const terminals=input.terminalIds.map(id=>results.get(id));if(terminals.some(value=>!value))throw Error('进度缺少原交付范围');
 const lag=terminals.length&&terminals.every(node=>node!.lagMinutes)?range(Math.max(...terminals.map(node=>node!.lagMinutes!.minimum)),Math.max(...terminals.map(node=>node!.lagMinutes!.maximum))):null;
 const provedLate=terminals.some(node=>node!.state==='late');
 const due=timestamp(input.customerGoal),delivered=terminals.length>0&&terminals.every(node=>node!.businessCompleted);
 return {scopeRef:input.scopeRef,lineId:input.lineId,targetRevision:input.targetRevision,state:termination&&!delivered?'terminated':provedLate?'late':state(lag),lagMinutes:lag,customerDuePassed:due===null?null:!delivered&&!termination&&now>=due,nodes:input.work.map(work=>results.get(work.id)!),coverage:[...new Set([...results.values()].flatMap(node=>node.coverage))]};
}

/** Whole-order spans use one physical time axis, never sums of node budgets,
 * parallel branches or PO clocks. Termination supplies an observation stop only. */
export function fixedDurationSummary(scopes:readonly ScheduleScopeInput[],asOf:string,termination?:ScheduleTermination|null):ScheduleDurationSummary{
 const starts=scopes.flatMap(scope=>scope.work.filter(work=>!work.includedIn&&work.dependsOn.length===0).map(work=>timestamp(work.start))),ends=scopes.map(scope=>{
  if(scope.customerGoal)return timestamp(scope.customerGoal);
  const terminalEnds=scope.terminalIds.map(id=>timestamp(scope.work.find(work=>work.id===id)?.end));
  return terminalEnds.length&&terminalEnds.every(at=>at!==null)?Math.max(...terminalEnds as number[]):null;
 });
 const roots=scopes.flatMap(scope=>scope.work.filter(work=>!work.includedIn&&work.dependsOn.length===0&&work.accountingRole!=='added_work').map(work=>scheduleOccurrenceBounds(scope.facts[work.id]?.ready??unknown,asOf)));
 // Missing original roots cannot be replaced by a surviving downstream R.
 const ready=roots.length&&roots.every((value):value is Interval=>value!==null)?roots:null;
 const terminal=scopes.flatMap(scope=>scope.terminalIds.map(id=>scope.facts[id]));
 const completion=terminal.map(fact=>completedBounds(fact,asOf));
 const allDelivered=terminal.length>0&&completion.every(Boolean),delivery=allDelivered?[Math.max(...completion.map(at=>at![0])),Math.max(...completion.map(at=>at![1]))] as const:null;
 const first=ready?.length?[Math.min(...ready.map(at=>at[0])),Math.min(...ready.map(at=>at[1]))] as const:null;
 const observed=allDelivered?delivery:termination?timestamp(termination.at)===null?null:[timestamp(termination.at)!,timestamp(termination.at)!] as const:[Date.parse(asOf),Date.parse(asOf)] as const;
 const span=first&&observed&&observed[0]>=first[1]?range((observed[0]-first[1])/MINUTE,(observed[1]-first[0])/MINUTE):null;
 const occurrence=(at:Interval|null):ScheduleOccurrence=>!at?unknown:at[0]===at[1]?{precision:'instant',at:iso(at[0])}:dateOf(at[0])===dateOf(at[1])?{precision:'date',date:dateOf(at[0])}:unknown;
 const planStart=starts.length&&starts.every(at=>at!==null)?Math.min(...starts as number[]):null,planEnd=ends.length&&ends.every(at=>at!==null)?Math.max(...ends as number[]):null;
 return {planStart:planStart===null?null:iso(planStart),planEnd:planEnd===null?null:iso(planEnd),actualStart:occurrence(first),observationAt:observed&&observed[0]===observed[1]?iso(observed[0]):null,deliveryCompletedAt:occurrence(delivery),planSpanMinutes:planStart!==null&&planEnd!==null?(planEnd-planStart)/MINUTE:null,elapsedSpanMinutes:span,finalActualSpanMinutes:allDelivered?span:null,asOf,coverage:[...(!first?['本单可信起点待核']:[]),...(!observed?['真实终止时间待核']:[]),...(planStart===null||planEnd===null?['完整冻结计划跨度待核']:[])]};
}
