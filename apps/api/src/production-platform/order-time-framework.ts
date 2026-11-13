import {z} from 'zod';
import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
import {SERIES_MILESTONES,type SeriesRoute} from '@dx-rework/contracts/digital-series-plan';
import {seriesMilestones} from '@dx-rework/domain/series-plan';
import {slaAnchorTime,type SlaAnchor,type SlaTime} from '@dx-rework/domain/digital-sla-plan';
import {FrameworkMilestoneStandardSchema,FrameworkResponsibilityWindowSchema,FrameworkRetainedWorkSchema,
 FrozenTimeFrameworkSchema,TimeFrameworkInputSchema,type FrozenTimeFramework,type TimeFrameworkInput,
 type FrameworkTarget,type FrameworkResponsibilityWindow} from '@dx-rework/contracts/order-time-framework';
import {buildOrderTimeWork} from './order-time-schedule.js';
import {fixedTimelineForward,shiftFixedTimeline} from './fixed-timeline-targets.js';
import {scheduleElapsed} from './fixed-schedule-progress.js';

const minute=60000;
const instant=z.iso.datetime({offset:true});
const missing=(reason:string):SlaTime=>({at:null,exclusive:false,reasons:[reason]});
function latest(values:SlaTime[]):SlaTime{
 if(!values.length)return missing('缺少必要完成工作');
 if(values.some(row=>!row.at))return {at:null,exclusive:false,reasons:[...new Set(values.flatMap(row=>row.reasons))]};
 return structuredClone(values.reduce((a,b)=>Date.parse(a.at!)>Date.parse(b.at!)||Date.parse(a.at!)===Date.parse(b.at!)&&a.exclusive?a:b));
}
/** Share original A/B constants without creating a second editable default. */
export function initialFrameworkMilestoneStandard(route:SeriesRoute,reference:string,revision:number){
 const original=seriesMilestones('2027-03-15',route);
 return FrameworkMilestoneStandardSchema.parse({reference,revision,offsets:Object.fromEntries(SERIES_MILESTONES.map(row=>[row.key,original.find(node=>node.key===row.key)?.offsetDays??null]))});
}

export type FrameworkCandidateContext={purpose:'settings_preview'|'order_proposal';observedAt:string;
 /** Only adapters with original source evidence may retain completed work or
  * begun work's separately established plan. This is not a ready-event writer. */
 retained?:Readonly<Record<string,{target:FrameworkTarget;sourceRef:string}>>};

/** Candidate-only pure evaluation. Ordinary reads decode the saved snapshot;
 * they do not call this function to slide its plan with the current clock.
 */
export function evaluateTimeFrameworkCandidate(value:TimeFrameworkInput,context:FrameworkCandidateContext){
 const input=TimeFrameworkInputSchema.parse(value),observedAt=instant.parse(context.observedAt);
 if(!['settings_preview','order_proposal'].includes(context.purpose))throw Error('正式读取不能重新生成有效安排');
 const retained=Object.fromEntries(Object.entries(context.retained??{}).map(([id,row])=>[id,FrameworkRetainedWorkSchema.parse(row)]));
 const work=input.work.map(row=>({id:row.id,parameterKey:row.parameterKey,stage:row.stage,dependsOn:row.dependsOn,
  ...(row.includedIn?{includedIn:row.includedIn}:{}),...(row.includedPosition?{includedPosition:row.includedPosition}:{}),
  ...(row.canonicalWorkRef?{canonicalWorkRef:row.canonicalWorkRef}:{})}));
 const arranged=fixedTimelineForward(buildOrderTimeWork(input.plan,work),input.acceptedAt,input.notBefore,
  {...(context.purpose==='order_proposal'?{minimumStart:{precision:'instant' as const,value:observedAt,source:'本次提交观察时刻'}}:{}),retained:Object.fromEntries(Object.entries(retained).map(([id,row])=>[id,row.target]))});
 const byId=new Map(arranged.map(row=>[row.id,row]));
 const milestones=input.bindings.map(binding=>{
  const offset=input.milestoneStandard.offsets[binding.key]!;
  const date=addCalendarDays(input.customerDelivery.date,-offset);
  const target=slaAnchorTime({precision:'date',value:date,source:input.customerDelivery.source},binding.key);
  const selected=binding.workIds.map(id=>byId.get(id)!),planned=latest(selected.map(row=>row.end));
  const known=selected.filter(row=>row.end.at!==null);
  // A missing branch cannot hide a separately proved late branch.
  const late=known.filter(row=>Date.parse(row.end.at!)>Date.parse(target.at!)||Date.parse(row.end.at!)===Date.parse(target.at!)&&!row.end.exclusive);
  const comparable=planned.at??(late.length?latest(late.map(row=>row.end)).at:null);
  const boundary=comparable!==null&&Date.parse(comparable)===Date.parse(target.at!)&&(planned.at?!planned.exclusive:true);
  const delta=comparable===null?null:(Date.parse(comparable)-Date.parse(target.at!)+(boundary?1:0))/minute;
  return {key:binding.key,date,target,planned,workIds:[...binding.workIds],
   status:late.length?'insufficient' as const:planned.at?'sufficient' as const:'unknown' as const,
   lateMinutes:delta===null?null:Math.max(0,delta),marginMinutes:planned.at&&delta!==null?-delta:null,
   blockingWorkIds:selected.filter(row=>!row.end.at||late.includes(row)).map(row=>row.id)};
 });
 const coverage=arranged.filter(row=>!row.start.at||!row.end.at).map(row=>row.id);
 return {purpose:context.purpose,observedAt,input,arranged,milestones,retained,coverage,
  status:milestones.some(row=>row.status==='insufficient')?'insufficient' as const:coverage.length||milestones.some(row=>row.status==='unknown')?'unknown' as const:'sufficient' as const};
}

/** Serialization boundary only. The original command still owns permission,
 * locking, approval, latest-input checks and persistence (enabled in PR06).
 * A risk acceptance is never permission to freeze missing necessary inputs.
 */
export function freezeTimeFrameworkCandidate(result:ReturnType<typeof evaluateTimeFrameworkCandidate>,version:{reference:string;revision:number;previousReference:string|null;eventRef:string}):FrozenTimeFramework{
 if(result.purpose!=='order_proposal')throw Error('设置演算不能成为正式订单安排');
 if(result.coverage.length||result.milestones.some(row=>!row.planned.at))throw Error('必要依据未齐，不能生效');
 return FrozenTimeFrameworkSchema.parse({...version,version:'order-time-framework-v1',effectiveAt:result.observedAt,
  input:result.input,arranged:result.arranged,milestones:result.milestones,retained:result.retained});
}

export type FrameworkActual={state:'not_started'}|{state:'running'}|{state:'completed';completion:SlaAnchor}|{state:'terminated';termination:SlaAnchor};
/** No task IDs are guessed and no clock is opened here. A captured native
 * window is the only authority for responsibility, even after a new plan.
 */
export function evaluateFrameworkResponsibility(input:{actual:FrameworkActual;window:FrameworkResponsibilityWindow|null;observedAt:string}){
 const now=instant.parse(input.observedAt),window=input.window?FrameworkResponsibilityWindowSchema.parse(input.window):null;
 const observation=input.actual.state==='completed'?slaAnchorTime(input.actual.completion,'实际完成')
  :input.actual.state==='terminated'?slaAnchorTime(input.actual.termination,'实际终止')
  :{at:now,exclusive:false,reasons:[]};
 if(input.actual.state==='not_started'){
  if(window)throw Error('未开始事实与已进入责任窗口矛盾');
  return {deadline:null,overdueMinutes:null,status:'not_started' as const};
 }
 const deadline=window?shiftFixedTimeline(window.startedAt,window.minutes,window.calendar):null;
 // Date-only actuals are intervals. Keep exact duration/attribution unknown.
 if(!window||!window.attributionKnown||!observation.at||observation.exclusive
  ||Date.parse(observation.at)<Date.parse(window.startedAt)||Date.parse(observation.at)>Date.parse(now))return {deadline,overdueMinutes:null,status:'unknown' as const};
 // Counted overdue duration uses the original clock's calendar, not wall time.
 const overdueMinutes=Math.max(0,scheduleElapsed(Date.parse(deadline!),Date.parse(observation.at),window.calendar));
 return {deadline,overdueMinutes,status:overdueMinutes>0?'overdue' as const:'within_window' as const};
}
