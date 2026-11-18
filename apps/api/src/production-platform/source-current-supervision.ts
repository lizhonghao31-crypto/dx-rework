import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {slaPastDeadline,type SlaAnchor,type SlaNodeEvaluation,type SlaNodeFact,type SlaPlan,type SlaTime} from '@dx-rework/domain/digital-sla-plan';
import type {StoredOrderTimePlan} from './order-time-plan-repository.js';
import {buildOrderTimeWork} from './order-time-schedule.js';
import {fixedTimelineForward,requiredFixedTimelineWork,shiftFixedTimeline} from './fixed-timeline-targets.js';
import type {ScheduleScopeInput,ScheduleWork,ScheduleFact} from './fixed-schedule-progress.js';

const missing=(reason:string):SlaTime=>({at:null,exclusive:false,reasons:[reason]});
const instant=(at:string):SlaTime=>({at,exclusive:false,reasons:[]});
const washingIds=new Set(['development_washing','development_washing_dispatch']);
type Forecast=Pick<SlaNodeEvaluation,'forecast'|'forecastBasis'>;

function observedForecast(at:string,work:ScheduleWork|undefined,fact:ScheduleFact|undefined,original:SlaNodeEvaluation|undefined,native:SlaNodeFact|undefined):Forecast|null{
 const unknown=(reason:string):Forecast=>({forecast:missing(reason),forecastBasis:'unknown'});
 if(original?.assessmentIssue)return {forecast:original.forecast,forecastBasis:'unknown'};
 if(fact?.businessCompleted){
  const completion=fact.completed.precision==='instant'?fact.completed.at:null;
  const ready=fact.clockStart.precision==='instant'?fact.clockStart.at:null;
  return completion&&Date.parse(completion)<=Date.parse(at)&&(!ready||Date.parse(completion)>=Date.parse(ready))
   ?{forecast:instant(completion),forecastBasis:'actual'}:unknown('原工作已完成，精确发生时间待核');
 }
 if(original&&(native?.businessCompleted||native?.completedAt||native?.waitingFor||native?.remaining||native?.startedAt||native?.batchWindows)){
  return {forecast:original.forecast,forecastBasis:original.forecastBasis};
 }
 if(fact?.clockStart.precision==='instant'){
  const start=fact.clockStart.at,minutes=work?.responsibilityMinutes,calendar=work?.responsibilityCalendar;
  if(minutes==null||!calendar||Date.parse(start)>Date.parse(at))return unknown('原责任窗口待核');
  const due=instant(shiftFixedTimeline(start,minutes,calendar));
  return slaPastDeadline(at,due)?unknown('原窗口已过，缺少剩余工时预计'):{forecast:due,forecastBasis:'standard_window'};
 }
 if(fact?.clockStart.precision==='date')return unknown('原责任起点只有日期，精确预计待核');
 return null;
}

/** Reuse the adopted graph and original publication anchor for the planned
 * view. A separate forward pass rolls trusted observations through the same
 * graph. Neither pass reads backward goals or rewrites responsibility facts. */
export function sourceCurrentSupervision(saved:StoredOrderTimePlan,scope:ScheduleScopeInput,original:SlaPlan,nodes:SlaNodeEvaluation[],native:Readonly<Record<string,SlaNodeFact>>,time:BusinessTime):SlaNodeEvaluation[]{
 const adopted=saved.input.scopes.find(value=>value.scopeRef===scope.scopeRef);
 if(!adopted||adopted.lineId!==null||scope.targetRevision!==`${saved.id}:${saved.revision}`)return nodes;
 const definitions=buildOrderTimeWork(saved.input.plan,saved.input.work);
 const required=requiredFixedTimelineWork(definitions,adopted.terminalIds),ids=new Set(required.map(work=>work.id));
 const graph=definitions.filter(work=>ids.has(work.id)||work.includedIn&&ids.has(work.includedIn));
 const origin: SlaAnchor=original.anchors.development_published??{precision:'unknown',reason:'缺少本开发单原发布时刻'};
 const bounds=saved.input.frameworkContext?.notBefore;
 const current=new Map(fixedTimelineForward(graph,origin,bounds).map(work=>[work.id,work]));
 const prior=new Map(nodes.map(node=>[node.id,node])),scopedWork=new Map(scope.work.map(work=>[work.id,work]));
 const workById=new Map(saved.input.work.map(work=>[work.id,work]));
 const exactLegacyId=(id:string)=>workById.get(id)?.canonicalWorkRef===`${scope.scopeRef}:work:${id}`||id==='order_creation'&&workById.get(id)?.canonicalWorkRef===`creation:source:${saved.resource.id}`;
 const forecasts=new Map<string,Forecast>();
 fixedTimelineForward(graph,origin,bounds,{project:target=>{
  const ref=workById.get(target.id)?.canonicalWorkRef;
  const work=scopedWork.get(target.id),fact=work&&ref===work.canonicalWorkRef?scope.facts[work.id]:undefined;
  const old=exactLegacyId(target.id)?prior.get(target.id):undefined;
  const evidence=old?native[old.id]:undefined;
  // Creation precedes publication. This synthetic route root must not move
  // the development forecast earlier than the original publication anchor.
  const observed=target.id==='order_creation'?null:observedForecast(time.now,work,fact,old,evidence);
  const forecast=observed??(!target.end.at?{forecast:target.end,forecastBasis:'unknown' as const}:slaPastDeadline(time.now,target.end)&&target.id!=='order_creation'
   ?{forecast:missing('计划时间已过，缺少有效的新预计'),forecastBasis:'unknown' as const}:{forecast:target.end,forecastBasis:'plan' as const});
  forecasts.set(target.id,forecast);
  const startedAt=!old?.assessmentIssue&&fact?.clockStart.precision==='instant'&&Date.parse(fact.clockStart.at)<=Date.parse(time.now)?fact.clockStart.at:old?.actualStart;
  return {start:startedAt?instant(startedAt):forecast.forecast.at?target.start:forecast.forecast,end:forecast.forecast};
 }});
 return nodes.map<SlaNodeEvaluation>(node=>{
  const work=current.get(node.id),forecast=forecasts.get(node.id);
  if(exactLegacyId(node.id)&&work&&forecast){
   const formal=scope.work.find(value=>value.id===node.id)?.approvedCurrentTarget;
   const approved=saved.input.formalTargets?.[scope.scopeRef]?.[node.id];
   return {...node,start:approved?.start??work.start,end:approved?.end??(formal?missing('原调整未保存剩余安排依据，请从本单时效重新核对并正式安排'):work.end),...forecast};
  }
  if(!washingIds.has(node.id))return node;
  const unknown=missing('现行安排缺少本轮洗水工作依据');
  return {...node,start:unknown,end:unknown,forecast:unknown,forecastBasis:'unknown'};
 });
}
