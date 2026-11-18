import type {JourneyBusinessDate,JourneyBusinessDateGroup,JourneyBusinessRequirement,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {journeyTimingKey} from './journey-supervision.js';

import {journeyActualPoint,type JourneyCompletionPoint as Point} from './journey-completion-evidence.js';
export {journeyActualPoint} from './journey-completion-evidence.js';
const day=(at:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(at));
const instant=(at:string)=>/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at));
const end=(date:string)=>Date.parse(`${date}T00:00:00+08:00`)+86400000;
/** Unknown time within a recorded day cannot become a precise midnight. An
 * instant after every date-only range can still be the provable final point.
 */
function latest(points:Point[]):Point|null{
 if(!points.length)return null;
 const dates=points.filter(point=>point.precision==='date'),instants=points.filter(point=>point.precision==='instant');
 const exact=instants.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
 const quality=points.every(point=>point.quality==='verified')?'verified':'recorded';
 if(exact&&(!dates.length||dates.every(point=>Date.parse(exact.at)>=end(point.at))))return {...exact,quality};
 return {at:points.map(point=>point.precision==='date'?point.at:day(point.at)).sort().at(-1)!,precision:'date',quality};
}
const base=(total:number):JourneyBusinessDate=>({at:null,precision:'unknown',quality:'unknown',status:total?'unknown':'not_applicable',covered:0,total,reasons:[]});
const withPoint=(value:JourneyBusinessDate,point:Point|null,complete:boolean):JourneyBusinessDate=>point?complete?{...value,at:point.at,precision:point.precision,quality:point.quality}:{...value,coveredAt:{at:point.at,precision:point.precision}}:value;
const timingPoint=(time:JourneyTiming['forecast']):Point|null=>!time.at||!instant(time.at)?null:time.exclusive
 ?{at:day(new Date(Date.parse(time.at)-1).toISOString()),precision:'date',quality:'recorded'}
 :{at:time.at,precision:'instant',quality:'recorded'};

/** Read the same effective requirement set as n/m. Partial coverage is retained
 * only as an explicitly labelled covered range, never a whole-order date.
 */
export function journeyBusinessDates(order:OrderJourney):NonNullable<NonNullable<OrderJourney['businessProgress']>['dates']>{
 const progress=order.businessProgress!;
 const allNodes=order.stages.flatMap(stage=>stage.nodes).filter(node=>node.current);
 const timings=order.supervision?.nodes??[];
 const summarize=(input:JourneyBusinessRequirement[]):JourneyBusinessDateGroup=>{
  const rows=input.filter(row=>row.applicability!=='not_applicable'),total=rows.length;
  const plans:Point[]=[],actuals:Point[]=[],forecasts:Point[]=[],bases=new Set<JourneyBusinessDateGroup['forecast']['bases'][number]>();
  const planReasons:string[]=[],actualReasons:string[]=[],forecastReasons:string[]=[];
  let planned=0,actual=0,forecast=0,completedWithoutTime=0,pendingForecasts=0,actualIncomplete=false;
  for(const row of rows){
   const nodes=allNodes.filter(node=>row.instanceIds.includes(node.instanceId));
   const matching=timings.filter(timing=>journeyTimingKey(timing.id)===journeyTimingKey(row.key)
    &&(!timing.id.includes(':task:')||row.instanceIds.includes(timing.id.split(':task:')[1]!)));
   if(row.applicability==='unknown'){
    planReasons.push(`${row.label}的适用范围尚未核实`);actualReasons.push(`${row.label}的完成范围尚未核实`);forecastReasons.push(`${row.label}的适用范围尚未核实`);continue;
   }
   const targetPoints=row.targets.map(target=>target.precision==='date'?isCalendarDate(target.at)?{at:target.at,precision:'date' as const,quality:'recorded' as const}:null:instant(target.at)?{at:target.at,precision:'instant' as const,quality:'recorded' as const}:null);
   if(targetPoints.length&&targetPoints.every(point=>point!==null)){planned++;plans.push(latest(targetPoints as Point[])!);}else planReasons.push(`${row.label}尚无完整对应的已采用计划日期`);
   const recordedCompletion=nodes.length>0&&nodes.length===row.instanceIds.length&&nodes.every(node=>node.state==='completed'||node.state==='inherited');
   if(!row.completed&&!recordedCompletion)actualIncomplete=true;
   if(recordedCompletion&&!row.completed){
    const reason=nodes.some(node=>node.state==='inherited')?'本轮采用完成时间尚未取得，原成果时间不作本轮完成时间':'原完成记录缺少截至本次观察的可信时间';
    actualReasons.push(`${row.label}：${reason}`);forecastReasons.push(`${row.label}：${reason}`);continue;
   }
   let completedPoint:Point|null=null;
   if(row.completed){
    if(nodes.some(node=>node.state==='inherited'&&!journeyActualPoint(node,progress.asOf)))actualReasons.push(`${row.label}沿用原成果，本轮采用完成时间尚未取得，原成果时间不作本轮完成时间`);
    else if(nodes.length===row.instanceIds.length&&nodes.length){const points=nodes.map(node=>journeyActualPoint(node,progress.asOf));if(points.every(point=>point!==null))completedPoint=latest(points as Point[]);}
    else if(!nodes.length&&matching.length&&(row.instanceIds.length===1&&matching.length===1||matching.every(timing=>timing.coverageComplete===true))&&matching.every(timing=>!timing.assessmentIssue&&timing.status.startsWith('completed')&&timing.actualEnd&&instant(timing.actualEnd)&&Date.parse(timing.actualEnd)<=Date.parse(progress.asOf)))completedPoint=latest(matching.map(timing=>({at:timing.actualEnd!,precision:'instant',quality:'recorded'})));
    if(completedPoint){actual++;actuals.push(completedPoint);}else if(!nodes.some(node=>node.state==='inherited'))actualReasons.push(`${row.label}业务已完成，尚无完整对应的实际完成时间`);
   }
   if(completedPoint){forecast++;forecasts.push(completedPoint);bases.add('actual');continue;}
   if(nodes.some(node=>node.state==='inherited')){forecastReasons.push(`${row.label}缺少本轮采用时间，不能以原成果时间推算`);continue;}
   if(row.completed){
    const contradictory=nodes.some(node=>node.timing?.assessmentIssue||Boolean((node.actualAt||node.actualDate)&&!journeyActualPoint(node,progress.asOf)))
     ||matching.some(timing=>timing.assessmentIssue);
    if(!contradictory)completedWithoutTime++;
    forecastReasons.push(`${row.label}${contradictory?'的实际时间依据不一致，尚不能纳入完整预计':'已完成但实际时间尚未取得'}`);continue;
   }
   if(!order.supervision||order.supervision.status==='limited'){forecastReasons.push(`${row.label}：${order.supervision?.status==='limited'?'当前岗位权限未包含本单整段时效依据':'尚未取得本次完整时效读取，请从本单座舱查看'}`);continue;}
   if(Date.parse(order.supervision.asOf)!==Date.parse(progress.asOf)){forecastReasons.push(`${row.label}的时效读取与本次业务快照时点不一致，请刷新`);continue;}
   if(matching.some(timing=>timing.forecastBasis==='actual'||timing.status.startsWith('completed'))){forecastReasons.push(`${row.label}原时效完成记录尚未覆盖当前未完成范围`);continue;}
   if(!matching.length||matching.some(timing=>timing.assessmentIssue||timing.coverageComplete===false)){
    forecastReasons.push(`${row.label}尚无覆盖全部适用范围的有效预计依据`);continue;
   }
   if(row.instanceIds.length>1&&!matching.every(timing=>timing.coverageComplete===true)){
    forecastReasons.push(`${row.label}的多个执行范围尚无完整逐项预计关联`);continue;
   }
   const points=matching.map(timing=>timingPoint(timing.forecast));
   if(points.some(point=>!point)||matching.some(timing=>timing.forecastBasis==='unknown'||timing.forecast.at&&Date.parse(timing.forecast.at)<Date.parse(progress.asOf))){
    forecastReasons.push(...matching.flatMap(timing=>timing.forecast.reasons.length?timing.forecast.reasons.map(reason=>`${row.label}：${reason}`):[`${row.label}的预计依据尚未齐全或已失效`]));continue;
   }
   forecast++;pendingForecasts++;forecasts.push(latest(points as Point[])!);
   for(const timing of matching)bases.add(timing.forecastBasis==='plan'?'sla_plan':timing.forecastBasis as 'actual'|'remaining_estimate'|'standard_window');
  }
  // Every completed native requirement precedes this observation even when its
  // precise occurrence is missing. A valid remaining-scope forecast is at/after
  // asOf and bounds that past work. It may establish the future endpoint without
  // inventing any past actual time. With no remaining forecast, unknown completed
  // dates still cannot become an overall completion or an asOf timestamp.
  if(pendingForecasts)forecast+=completedWithoutTime;
  const actualDate=withPoint({...base(total),covered:actual,status:!total?'not_applicable':actualIncomplete?'incomplete':actual===total?'complete':'unknown',reasons:actualReasons},latest(actuals),!actualIncomplete&&actual===total);
  const planAvailable=progress.plan.status==='complete'||progress.plan.status==='partial';
  const adoptedPlan=withPoint({...base(total),covered:planAvailable?planned:0,status:!total?'not_applicable':!planAvailable?'unknown':planned===total?'complete':planned?'partial':'unknown',reasons:planAvailable?planReasons:progress.plan.reasons},planAvailable?latest(plans):null,planAvailable&&planned===total);
  const forecastDate=withPoint({...base(total),covered:forecast,status:!total?'not_applicable':forecast===total?'complete':forecast?'partial':'unknown',reasons:[...new Set(forecastReasons)]},latest(forecasts),forecast===total);
  const sourcePlans=planAvailable?[...new Map(rows.flatMap(row=>row.targets.map(target=>[`${target.planId}:${target.revision}`,{planId:target.planId,revision:target.revision}] as const))).values()]:[];
  return {actual:actualDate,adoptedPlan:{...adoptedPlan,...(!order.orderId?{status:'not_applicable' as const,reasons:[]}:{}),planId:progress.plan.planId,revision:progress.plan.revision,sourcePlans},forecast:{...forecastDate,bases:[...bases].sort()}};
 };
 return {asOf:progress.asOf,overall:summarize(progress.requirements),stages:order.stages.map(stage=>({key:stage.key,...summarize(progress.requirements.filter(row=>row.stage===stage.key))}))};
}
