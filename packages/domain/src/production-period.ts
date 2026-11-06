import {addCalendarDays,isCalendarDate,calendarDaysBetween} from '@dx-rework/contracts/series-calendar';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import type {StatisticsTime} from '@dx-rework/contracts/production-statistics';
import type {ProductionPeriod,ProductionPeriodEvent,ProductionPeriodTotal,ProductionPromiseVersion,ProductionCompletion,ProductionDueResult,ProductionPeriodComparison} from '@dx-rework/contracts/production-period';

const instant=(value:string)=>{const parsed=Date.parse(value);if(!/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(parsed))throw Error('Explicit valid historical instant required');return parsed;};
function range(period:ProductionPeriod){if(!isCalendarDate(period.from)||!isCalendarDate(period.to)||period.to<period.from)throw Error('Explicit ordered Beijing period required');const start=instant(period.from+'T00:00:00+08:00'),end=instant(addCalendarDays(period.to,1)+'T00:00:00+08:00'),cutoff=period.cutoffAt?instant(period.cutoffAt):null;if(cutoff!==null&&(cutoff<start||cutoff>=end))throw Error('Comparison cutoff must fall within its original Beijing period');return {start,end,cutoff};}
function occurrence(time:StatisticsTime):{start:number;end:number}|null{
 if(time.quality!=='verified'||time.precision==='unknown')return null;
 if(time.precision==='date')return time.date&&isCalendarDate(time.date)?{start:instant(time.date+'T00:00:00+08:00'),end:instant(addCalendarDays(time.date,1)+'T00:00:00+08:00')}:null;
 if(!time.at||!Number.isFinite(Date.parse(time.at)))return null;const at=instant(time.at);return {start:at,end:at};
}

/** Adapters must supply effective original event revisions and the event's own
 * unit/scope. Cumulative quantities must first be resolved by their native facts. */
export function productionPeriodTotals(events:ProductionPeriodEvent[],period:ProductionPeriod,asOf?:string):ProductionPeriodTotal[]{
 const bounds=range(period),now=asOf?instant(asOf):null,totals=new Map<string,ProductionPeriodTotal>(),roots=new Map<string,ProductionPeriodEvent[]>();
 for(const event of events.filter(event=>event.effective)){const key=event.kind+':'+event.rootId;roots.set(key,[...(roots.get(key)??[]),event]);}
 for(const versions of roots.values()){
  const event=versions[0]!,key=JSON.stringify([event.kind,event.unit]),metric=totals.get(key)??{kind:event.kind,...event.label?{label:event.label}:{},unit:event.unit,value:0,knownValue:0,eventIds:[],unknown:[],outsideIds:[]};totals.set(key,metric);
  if(versions.some(value=>JSON.stringify(value)!==JSON.stringify(event))){metric.unknown.push({id:event.rootId,reason:'同原事件有矛盾有效版本，不能重复计或任取新版'});continue;}
  const at=occurrence(event.occurred);if(!at){metric.unknown.push({id:event.id,reason:'缺可信业务发生日，保当前事实但不拿登记时间归入期间'});continue;}
  if(now!==null&&at.start>now){metric.unknown.push({id:event.id,reason:'原事实发生晚于本次观察，不能计为已发生产出'});continue;}
  if(at.start<bounds.start||at.start>=bounds.end||bounds.cutoff!==null&&at.start>bounds.cutoff){metric.outsideIds.push(event.id);continue;}
  if(bounds.cutoff!==null&&at.end>bounds.cutoff&&at.start!==at.end){metric.unknown.push({id:event.id,reason:'原事件只有业务日期，无法确认在本期相同经过时长的截止前或后'});continue;}
  if(event.quantity===null||!Number.isFinite(event.quantity)||event.quantity<0){metric.unknown.push({id:event.id,reason:event.unknownReason??'原有效发生量缺件'});continue;}
  metric.knownValue+=event.quantity;metric.eventIds.push(event.id);
 }
 for(const metric of totals.values())metric.value=metric.unknown.length?null:metric.knownValue;
 return [...totals.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.unit.localeCompare(b.unit));
}

/** A late replacement preserves the expired promise window. An explicitly
 * effective pre-deadline replacement moves that obligation with its evidence. */
export function productionDueQueue(promises:ProductionPromiseVersion[],completions:ProductionCompletion[],period:ProductionPeriod,asOf:string):ProductionDueResult{
 const bounds=range(period),observed=instant(asOf),now=Math.min(observed,bounds.cutoff??observed),result:ProductionDueResult={rows:[],moved:[],unknown:[],knownDenominator:0,knownOnTime:0,rate:null},scopes=new Map<string,ProductionPromiseVersion[]>();
 for(const promise of promises)scopes.set(promise.scopeId,[...(scopes.get(promise.scopeId)??[]),promise]);
 for(const [scopeId,input]of scopes){
  const ordered=[...input].sort((a,b)=>a.version-b.version),completeChain=ordered.every((promise,index)=>promise.version===index+1),relevant=input.some(promise=>{const deadline=instant(promise.deadline),due=promise.deadlineExclusive?now>=deadline:now>deadline,date=beijingCalendarDate(new Date(deadline-(promise.deadlinePrecision==='date'?1:0)));return due&&date>=period.from&&date<=period.to;});
  if(completeChain&&!relevant)continue;
  if(input.some(promise=>promise.assessmentUnknown?.length)){result.unknown.push({scopeId,reason:[...new Set(input.flatMap(promise=>promise.assessmentUnknown??[]))].join('；')});continue;}
  const versions=[...input].sort((a,b)=>a.version-b.version),kept:ProductionPromiseVersion[]=[];let active:ProductionPromiseVersion|undefined;
  const facts=completions.filter(fact=>fact.scopeId===scopeId),completion=facts[0]??null;
  if(facts.some(fact=>JSON.stringify(fact)!==JSON.stringify(completion))){result.unknown.push({scopeId,reason:'同一责任范围有矛盾有效完成事实'});continue;}
  let invalid=false;
  for(const [index,version]of versions.entries()){
   const effective=occurrence(version.effective);if(version.version!==index+1||!effective){result.unknown.push({scopeId,reason:'承诺版本链或合法生效时间缺证，不能用最新交期重写旧评价'});invalid=true;break;}
   if(effective.start>now)continue;
   if(bounds.cutoff!==null&&effective.end>now&&effective.end!==effective.start){result.unknown.push({scopeId,reason:'承诺仅有生效日期，无法核实在相同经过时长截止前已生效'});invalid=true;break;}
   if(active){const priorDeadline=instant(active.deadline),before=effective.end<priorDeadline||effective.end===priorDeadline&&(version.effective.precision==='date'||!active.deadlineExclusive),after=effective.start>=priorDeadline;
    if(before)result.moved.push({scopeId,fromPromiseId:active.promiseId,toPromiseId:version.promiseId});else if(after)kept.push(active);else{result.unknown.push({scopeId,reason:'承诺生效精度不能判定在旧截止前或后'});invalid=true;break;}}
   active=version;
  }
  if(invalid)continue;if(active)kept.push(active);
  for(const promise of kept){
   const deadline=instant(promise.deadline),due=promise.deadlineExclusive?now>=deadline:now>deadline,day=promise.deadlinePrecision==='date'?beijingCalendarDate(new Date(deadline-1)):beijingCalendarDate(new Date(deadline));
   if(!due||day<period.from||day>period.to||deadline<bounds.start||deadline>bounds.end)continue;
   const completed=completion?occurrence(completion.occurred):null,unknown:string[]=[];let onTime:boolean|null=false;
   if(completion&&!completed){onTime=null;unknown.push('完成事实缺可信发生时间，不能用登记时刻填补');}
   else if(completed){if(completed.start>observed){onTime=null;unknown.push('完成发生时间晚于本次业务观察');}else if(completed.start>now){onTime=false;}else if(completed.end<=deadline&&(completion!.occurred.precision==='date'||!promise.deadlineExclusive||completed.end<deadline))onTime=true;else if(completed.start>=deadline&&(promise.deadlineExclusive||completed.start>deadline))onTime=false;else{onTime=null;unknown.push('完成时间精度跨越截止，不能判定按期或迟交');}}
   result.rows.push({scopeId,promiseId:promise.promiseId,promiseVersion:promise.version,deadline:promise.deadline,deadlineExclusive:promise.deadlineExclusive,completion,onTime,unknown});
  }
 }
 result.knownDenominator=result.rows.length;result.knownOnTime=result.rows.filter(row=>row.onTime===true).length;
 result.rate=result.unknown.length||result.rows.some(row=>row.onTime===null)||!result.knownDenominator?null:result.knownOnTime/result.knownDenominator;return result;
}

/** Comparison metadata never turns an incomplete/changed-rule series into a
 * performance conclusion. Rates are returned as percentage-point changes. */
export function productionPeriodComparison(current:ProductionPeriod,baseline:ProductionPeriod,asOf:string,currentValue:number|null,baselineValue:number|null,options:{rate?:boolean;currentRule:string;baselineRule:string}):ProductionPeriodComparison{
 const c=range(current),b=range(baseline),now=instant(asOf),today=beijingCalendarDate(new Date(now)),days=(period:ProductionPeriod)=>calendarDaysBetween(period.from,period.to)+1,elapsed=(period:ProductionPeriod)=>Math.max(0,Math.min(days(period),calendarDaysBetween(period.from,today)+1));
 const currentDays=days(current),baselineDays=days(baseline),currentElapsedDays=elapsed(current),baselineElapsedDays=elapsed(baseline),complete=now>=c.end&&now>=b.end&&c.cutoff===null&&b.cutoff===null,equalElapsed=Math.max(0,Math.min(now,c.cutoff??c.end,c.end)-c.start)===Math.max(0,Math.min(now,b.cutoff??b.end,b.end)-b.start),ruleChanged=options.currentRule!==options.baselineRule,reason:string[]=[];
 if(!complete)reason.push('至少一个期间尚未完整经过，按已展示的业务时刻截止比较，不能冒充完整期间');if(!equalElapsed)reason.push('两期已经过时长不同');if(ruleChanged)reason.push('两期评价规则或适用版本构成不同，差异不能直接归作表现变化');if(currentValue===null||baselineValue===null)reason.push('存在未知或无分母，不能用0替代');
 const valid=currentValue!==null&&baselineValue!==null&&Number.isFinite(currentValue)&&Number.isFinite(baselineValue),difference=valid?currentValue!-baselineValue!:null,zeroBaseline=valid&&baselineValue===0&&currentValue!==0;
 return {current,baseline,currentDays,baselineDays,currentElapsedDays,baselineElapsedDays,complete,equalElapsed,ruleChanged,difference,percentChange:valid&&!options.rate&&baselineValue!==0?difference!/baselineValue!*100:null,percentagePoints:valid&&options.rate?difference!*100:null,zeroBaseline,reason};
}
export function previousProductionPeriod(current:ProductionPeriod):ProductionPeriod{range(current);const count=calendarDaysBetween(current.from,current.to)+1;return {from:addCalendarDays(current.from,-count),to:addCalendarDays(current.from,-1)};}
/** Both periods end at the same physical elapsed duration in Beijing, including the partial current day. */
export function sameElapsedProductionPeriods(current:ProductionPeriod,baseline:ProductionPeriod,asOf:string):{current:ProductionPeriod;baseline:ProductionPeriod}|null{
 const c=range(current),b=range(baseline),now=instant(asOf),elapsed=Math.max(0,Math.min(c.end-c.start,b.end-b.start,now-c.start,now-b.start));
 if(!elapsed)return null;
 const clipped=(period:ProductionPeriod,bounds:ReturnType<typeof range>):ProductionPeriod=>elapsed>=bounds.end-bounds.start?{from:period.from,to:period.to}:{from:period.from,to:period.to,cutoffAt:new Date(bounds.start+elapsed).toISOString()};
 return {current:clipped(current,c),baseline:clipped(baseline,b)};
}
