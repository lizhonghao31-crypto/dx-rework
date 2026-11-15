import type {FixedScheduleCalendar,ScheduleOccurrence,ScheduleRange,ScheduleGoalDelta,ScheduleNodeProgress,ScheduleScopeProgress,ScheduleDurationSummary} from '@dx-rework/contracts';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';

export type ScheduleWork={id:string;canonicalWorkRef:string;stage?:number;dependsOn:readonly string[];dependencyReserves?:Readonly<Record<string,{minutes:number;calendar:FixedScheduleCalendar}>>;start:string|null;end:string|null;startExclusive?:boolean;endExclusive?:boolean;eventTarget?:{end:string|null;targetPrecision:'instant'|'date';targetDate:string|null;exclusive:boolean};minutes:number|null;calendar:FixedScheduleCalendar|null;includedIn?:string;accountingRole?:'original_work'|'added_work'|'included'|'event'|'shared_reference';originalHandoffAt?:string|null;responsibilitySlaRef:string|null;responsibilityMinutes?:number|null;responsibilityCalendar?:FixedScheduleCalendar|null;responsibilityWarningAt?:string|null;responsibilityReminderPercent?:number|null;targetPrecision?:'instant'|'date';targetDate?:string|null;targetRevision?:string;completionTarget?:{end:string;endExclusive?:boolean;targetRevision:string;targetPrecision:'instant'|'date';targetDate:string|null}|null};
export type ScheduleResponsibilityWindow={sourceRef:string;started:ScheduleOccurrence;completed:ScheduleOccurrence;complete:boolean;deadline:string|null;warningAt:string|null;calendar:FixedScheduleCalendar|null};
export type ScheduleFact={ownTaskId?:string;ready:ScheduleOccurrence;completed:ScheduleOccurrence;businessCompleted:boolean;waitingForPredecessors:boolean;clockStart:ScheduleOccurrence;evidenceRefs:readonly string[];ownWindows?:readonly ScheduleResponsibilityWindow[];impactStartedAt?:string|null;terminated?:boolean;terminationAt?:string|null;notYetReady?:boolean};
export type ScheduleScopeInput={plannedReadiness?:boolean;scopeRef:string;lineId:string|null;targetRevision:string;work:readonly ScheduleWork[];facts:Readonly<Record<string,ScheduleFact>>;terminalIds:readonly string[];customerGoal:string|null};
export type ScheduleTermination={at:string|null;kind:'cancelled'|'special_closure'};
type Interval=readonly[number,number];
type Boundary={available:Interval;credit:Interval;reference:number;completed:boolean;estimate:'actual'|'conditional'|'lower_bound';exclusive?:boolean};
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

/** A later batch never resets an older batch's original D or charges the gap
 * between batches to one employee. Actual completed windows stay frozen. */
function nativeOwnWindows(windows:readonly ScheduleResponsibilityWindow[],asOf:string,stop:number|null,terminated:boolean):ScheduleNodeProgress['ownSla']{
 const now=Date.parse(asOf),values=windows.map(window=>{
  const start=scheduleOccurrenceBounds(window.started,asOf),deadline=timestamp(window.deadline);
  const completed=window.complete?completedBounds({ready:window.started,clockStart:window.started,completed:window.completed,businessCompleted:true,waitingForPredecessors:false,evidenceRefs:[]},asOf):null;
  const end=window.complete?completed:terminated?stop!==null&&stop<=now?[stop,stop] as const:null:[now,now] as const;
  if(!start||deadline===null||!window.calendar||!end||end[1]<start[0]||deadline<start[0])return null;
  return range(Math.max(0,scheduleElapsed(deadline,end[0],window.calendar)),Math.max(0,scheduleElapsed(deadline,end[1],window.calendar)));
 });
 const known=values.filter((value):value is ScheduleRange=>value!==null),all=known.length===windows.length;
 const overdue=known.some(value=>value.minimum>0),within=all&&known.every(value=>value.maximum===0);
 const warning=windows.filter((window,index)=>values[index]&&!window.complete&&window.warningAt&&Date.parse(window.warningAt)<=now);
 const warningAt=windows.filter((window,index)=>values[index]&&!window.complete&&window.warningAt).map(window=>window.warningAt!).sort()[0]??null;
 const deadlines=windows.map(window=>{const start=scheduleOccurrenceBounds(window.started,asOf),deadline=timestamp(window.deadline);return start&&window.calendar&&deadline!==null&&deadline>=start[0]?iso(deadline):null;}),deadlineAt=deadlines.length&&deadlines.every(at=>at!==null&&at===deadlines[0])?deadlines[0]!:null;
 return {state:terminated?'terminated':overdue?'overdue':within?'within':'unknown',deadlineAt,overdueMinutes:all?range(Math.max(...known.map(value=>value.minimum)),Math.max(...known.map(value=>value.maximum))):null,sourceRef:windows.map(window=>window.sourceRef).join(';'),warningAt,warning:!terminated&&!overdue&&warning.length>0};
}

export function fixedGoalDelta(work:ScheduleWork,fact:ScheduleFact|undefined,scope:Pick<ScheduleScopeInput,'scopeRef'|'targetRevision'>,asOf:string,termination?:ScheduleTermination|null):ScheduleGoalDelta{
 if(fact?.businessCompleted&&work.completionTarget!==undefined){
  const {completionTarget,...base}=work;delete base.eventTarget;
  if(completionTarget===null)return {...fixedGoalDelta({...base,end:null},fact,scope,asOf,termination),targetRevision:'unknown:completion-plan'};
  return fixedGoalDelta({...base,...completionTarget,endExclusive:completionTarget.endExclusive??false},fact,scope,asOf,termination);
 }
 if(work.eventTarget){const {eventTarget,...base}=work;return fixedGoalDelta({...base,...eventTarget,endExclusive:eventTarget.exclusive},fact,scope,asOf,termination);}
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
 if(!fact?.businessCompleted){const value=Math.max(0,(now-end+(work.endExclusive&&now===end?1:0))/MINUTE);return {...result,signedValue:value,kind:value>0?'late':'on_target'};}
 const actual=completedBounds(fact,asOf);if(!actual||actual[0]!==actual[1])return result;
 const value=(actual[0]-end+(work.endExclusive&&actual[0]===end?1:0))/MINUTE;return {...result,signedValue:value,kind:value>0?'late':value<0?'early':'on_target'};
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
  const fact=input.facts[id],coverage:string[]=[],added=work.accountingRole==='added_work',budget=added?0:work.minutes,eventPosition=work.eventTarget&&!fact?.businessCompleted?work.eventTarget.end:undefined,start=timestamp(eventPosition??(added?work.originalHandoffAt:work.start)),end=timestamp(work.eventTarget?.end??(added?work.originalHandoffAt:work.end)),calendar=work.calendar??(budget===0?'continuous':null);
  const completed=fact?.businessCompleted===true,actual=completedBounds(fact,asOf);
  const terminated=!completed&&Boolean(termination||fact?.terminated);
  const deps=work.dependsOn.map(evaluate);
  const goalDelta=fixedGoalDelta(work,fact,input,asOf,termination);
  let boundary:Boundary|null=null;
  if(work.accountingRole==='added_work'&&timestamp(work.originalHandoffAt)===null)coverage.push('新增范围缺少原交接目标');
  else if(completed&&actual&&end!==null)boundary={available:actual,credit:actual,reference:work.accountingRole==='added_work'?timestamp(work.originalHandoffAt)??end:end,completed:true,estimate:'actual'};
  else if(completed)coverage.push('已完成但实际发生时间待核');
  else if(terminated)coverage.push('已终止');
  else if(start===null||end===null||budget===null||budget<0||!calendar)coverage.push('本范围冻结目标、规划时长或日历待核');
  else if(work.includedIn){boundary=evaluate(work.includedIn);}
  else if(deps.some(dep=>!dep))coverage.push('必要前序可交时间待核');
  else {
   const ready=fact?scheduleOccurrenceBounds(fact.ready,asOf):null;
   const allComplete=deps.every(dep=>dep!.completed);
   if(!input.plannedReadiness&&!ready&&work.accountingRole!=='added_work'&&!(deps.length&&!allComplete&&fact?.waitingForPredecessors))coverage.push('真实就绪或未完成前置依据待核');
   else {
    const available:number[]=[],credit:number[]=[];let lowerBound=deps.some(dep=>dep!.estimate==='lower_bound');
    const dependencyArrival=(dep:Boundary,index:number,side:0|1)=>{
     const reserve=work.dependencyReserves?.[work.dependsOn[index]!];
     return reserve?shift(dep.available[side],reserve.minutes,reserve.calendar):dep.available[side];
    };
    for(const side of [0,1] as const){
     const candidates=deps.map((dep,index)=>{
      const arrival=dependencyArrival(dep!,index,side);
      return dep!.completed?arrival:Math.max(arrival,shift(start,Math.min(0,scheduleElapsed(dep!.reference,dep!.credit[side],calendar)),calendar));
     });
     const join=candidates.length?Math.max(...candidates):start;
     const joinCredit=allComplete&&deps.length?join:shift(start,Math.min(0,scheduleElapsed(start,join,calendar)),calendar);
     const position=Math.max(join,shift(start,Math.min(0,scheduleElapsed(start,joinCredit,calendar)),calendar),ready?.[side]??(input.plannedReadiness?Math.max(now,start):-Infinity));
     if(work.accountingRole==='added_work'){
      const impact=timestamp(fact?.impactStartedAt),active=impact!==null&&impact<=now;
      available.push(active?Math.max(join,now):join);credit.push(active?Math.max(joinCredit,now):joinCredit);lowerBound ||= active;
     }else{
      const quota=shift(position,budget!,calendar),bound=ready?Math.max(quota,now):quota;
      available.push(bound);credit.push(shift(end,Math.min(0,scheduleElapsed(end,bound,calendar)),calendar));lowerBound ||= Boolean(ready&&now>=quota)||Boolean(input.plannedReadiness&&!ready&&now>start);
     }
    }
    // A future date position keeps its open endpoint even when an upstream
    // overrun removes the forecast's upper bound. This is not an assurance of
    // finishing: the estimate remains lower_bound. Once now reaches the end,
    // or a required actual branch arrives there, equality is genuinely late.
    const exclusive=!ready&&now<end&&(work.eventTarget?.exclusive??work.endExclusive)===true
     &&available.every(at=>at===end)&&deps.every((dep,index)=>{
      const arrival=dependencyArrival(dep!,index,1);
      return arrival<start||arrival===start&&dep!.exclusive===true;
     });
    boundary={available:[available[0]!,available[1]!],credit:[credit[0]!,credit[1]!],reference:work.accountingRole==='added_work'?timestamp(work.originalHandoffAt)??end:end,completed:false,estimate:lowerBound?'lower_bound':'conditional',exclusive};
   }
  }
  const strictEnd=work.eventTarget?.exclusive??work.endExclusive;
  const boundaryLag=(at:number)=>scheduleElapsed(end!,at,calendar!)+(strictEnd&&!boundary?.exclusive&&at===end?1/MINUTE:0);
  const lag=boundary&&end!==null&&calendar?range(boundaryLag(boundary.available[0]),boundaryLag(boundary.available[1])):null;
  const stop=terminated?timestamp(fact?.terminated?fact.terminationAt??termination?.at:termination?.at):null;
  const ownCalendar=work.responsibilityCalendar,ownStart=fact?scheduleOccurrenceBounds(fact.clockStart,asOf):null,ownEnd=completed?actual:terminated?stop!==null&&stop<=now?[stop,stop] as const:null:[now,now] as const;
  const ownKnown=Boolean(work.responsibilitySlaRef&&work.responsibilityMinutes!==null&&work.responsibilityMinutes!==undefined&&ownCalendar&&ownStart&&ownEnd&&ownEnd[1]>=ownStart[0]);
  const own=ownKnown?range(Math.max(0,scheduleElapsed(ownStart![1],ownEnd![0],ownCalendar!)-work.responsibilityMinutes!),Math.max(0,scheduleElapsed(ownStart![0],ownEnd![1],ownCalendar!)-work.responsibilityMinutes!)):null;
  const ownState=!work.responsibilitySlaRef?'not_adopted':terminated?'terminated':!own?'unknown':own.minimum>0?'overdue':own.maximum===0?'within':'unknown';
  const warningAt=work.responsibilityWarningAt!==undefined?work.responsibilityWarningAt:ownKnown&&ownStart![0]===ownStart![1]&&work.responsibilityReminderPercent!==null&&work.responsibilityReminderPercent!==undefined?iso(shift(ownStart![0],work.responsibilityMinutes!*work.responsibilityReminderPercent/100,ownCalendar!)):null;
  const deadlineAt=work.responsibilitySlaRef&&work.responsibilityMinutes!==null&&work.responsibilityMinutes!==undefined&&ownCalendar&&ownStart&&ownStart[0]===ownStart[1]?iso(shift(ownStart[0],work.responsibilityMinutes,ownCalendar)):null;
  const ownSla:ScheduleNodeProgress['ownSla']=fact?.ownWindows?.length?nativeOwnWindows(fact.ownWindows,asOf,stop,terminated):{state:ownState,deadlineAt,overdueMinutes:own,sourceRef:work.responsibilitySlaRef,...(work.responsibilityWarningAt!==undefined||work.responsibilityReminderPercent!==undefined?{warningAt,warning:!completed&&!terminated&&ownState==='within'&&warningAt!==null&&now>=Date.parse(warningAt)}:{})};
  results.set(id,{id,scopeRef:input.scopeRef,targetRevision:work.targetRevision??input.targetRevision,canonicalWorkRef:work.canonicalWorkRef,state:terminated?'terminated':state(lag),lagMinutes:lag,businessCompleted:completed,...(input.plannedReadiness?{estimateKind:terminated?'terminated' as const:boundary?.estimate??'unknown' as const}:{}),availabilityBound:boundary?{earliest:iso(boundary.available[0]),latest:iso(boundary.available[1]),...(boundary.exclusive?{exclusive:true}:{})}:null,creditLimit:boundary?{earliest:iso(boundary.credit[0]),latest:iso(boundary.credit[1])}:null,goalDelta,...(work.completionTarget!==undefined?{currentTarget:{at:work.eventTarget?work.eventTarget.end:work.end,date:work.eventTarget?work.eventTarget.targetDate:work.targetDate??null,precision:work.eventTarget?.targetPrecision??work.targetPrecision??'instant',revision:work.targetRevision??input.targetRevision}}:{}),ownSla,coverage});
  visiting.delete(id);boundaries.set(id,boundary);return boundary;
 };
 for(const work of input.work)evaluate(work.id);
 const terminals=input.terminalIds.map(id=>results.get(id));if(terminals.some(value=>!value))throw Error('进度缺少原交付范围');
 const lag=terminals.length&&terminals.every(node=>node!.lagMinutes)?range(Math.max(...terminals.map(node=>node!.lagMinutes!.minimum)),Math.max(...terminals.map(node=>node!.lagMinutes!.maximum))):null;
 const provedLate=terminals.some(node=>node!.state==='late');
 const due=timestamp(input.customerGoal),delivered=terminals.length>0&&terminals.every(node=>node!.businessCompleted);
 const ends=input.terminalIds.map(id=>boundaries.get(id));
 const completionEstimate=!delivered&&termination?{kind:'terminated' as const,earliest:null,latest:null}
  :!ends.length||ends.some(end=>!end)?{kind:'unknown' as const,earliest:null,latest:null}
  :{kind:ends.every(end=>end!.completed)?'actual' as const:ends.some(end=>end!.estimate==='lower_bound')?'lower_bound' as const:'conditional' as const,
    earliest:iso(Math.max(...ends.map(end=>end!.available[0]))),latest:ends.some(end=>end!.estimate==='lower_bound')?null:iso(Math.max(...ends.map(end=>end!.available[1])))};
 return {scopeRef:input.scopeRef,lineId:input.lineId,targetRevision:input.targetRevision,state:termination&&!delivered?'terminated':provedLate?'late':state(lag),lagMinutes:lag,customerDuePassed:due===null?null:!delivered&&!termination&&now>=due,nodes:input.work.map(work=>results.get(work.id)!),coverage:[...new Set([...results.values()].flatMap(node=>node.coverage))],completionEstimate};
}

/** Whole-order spans use one physical time axis, never sums of node budgets,
 * parallel branches or PO clocks. Termination supplies an observation stop only. */
export function fixedDurationSummary(scopes:readonly ScheduleScopeInput[],asOf:string,termination?:ScheduleTermination|null):ScheduleDurationSummary{
 const deliveryWork=(scope:ScheduleScopeInput)=>{
  const selected=new Set<string>(),visiting=new Set<string>(),byId=new Map(scope.work.map(work=>[work.id,work]));
  const visit=(id:string)=>{if(selected.has(id))return;if(visiting.has(id))throw Error('交付用时依赖成环');const work=byId.get(id);if(!work)throw Error('交付用时缺少必要节点');visiting.add(id);for(const dep of work.dependsOn)visit(dep);if(work.includedIn)visit(work.includedIn);visiting.delete(id);selected.add(id);};
  for(const id of scope.terminalIds)visit(id);return scope.work.filter(work=>selected.has(work.id));
 };
 const starts=scopes.flatMap(scope=>deliveryWork(scope).filter(work=>!work.includedIn&&work.dependsOn.length===0).map(work=>timestamp(work.start))),ends=scopes.map(scope=>{
  if(scope.customerGoal)return timestamp(scope.customerGoal);
  const terminalEnds=scope.terminalIds.map(id=>timestamp(scope.work.find(work=>work.id===id)?.end));
  return terminalEnds.length&&terminalEnds.every(at=>at!==null)?Math.max(...terminalEnds as number[]):null;
 });
 const roots=scopes.flatMap(scope=>deliveryWork(scope).filter(work=>!work.includedIn&&work.dependsOn.length===0&&work.accountingRole!=='added_work').filter(work=>{
  const fact=scope.facts[work.id];return !(fact?.notYetReady===true&&!fact.businessCompleted&&fact.clockStart.precision==='unknown'&&fact.ready.precision==='unknown');
 }).map(work=>scheduleOccurrenceBounds(scope.facts[work.id]?.ready??unknown,asOf)));
 // A positively known future root is different from a missing historical R.
 // Missing original starts cannot be replaced by a surviving downstream R.
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
