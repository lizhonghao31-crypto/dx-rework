import {CockpitDate} from './cockpit-date.js';
import {scopedDeadlineFallback} from './journey-sla-details.js';
import {useEffect,useRef,useState} from 'react';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {ScheduleGoalDelta,ScheduleNodeProgress,ScheduleRange,ScheduleScopeProgress} from '@dx-rework/contracts';
const minute=60000,day=86400000;
export function cockpitDuration(value:number|null|undefined){
 if(value===null||value===undefined||!Number.isFinite(value)||value<0)return '—';
 if(value>0&&value<1)return '不足1分钟';
 const whole=Math.round(value),days=Math.floor(whole/1440),hours=Math.floor(whole%1440/60),minutes=whole%60;
 return [days?days+'天':'',hours?hours+'小时':'',minutes?minutes+'分钟':''].filter(Boolean).join('')||'0分钟';
}
export function cockpitDurationRange(value:ScheduleRange|null|undefined){return !value?'—':value.minimum===value.maximum?cockpitDuration(value.minimum):cockpitDuration(value.minimum)+'～'+cockpitDuration(value.maximum);}
/** A visible unfinished number follows the server's proven live clock only.
 * Frozen TEST clocks, stale reads and completed/terminated evidence never tick. */
export function useScheduleObservation(order:OrderJourney,stale=false){
 const schedule=order.fixedSchedule,origin=useRef(performance.now()),[elapsed,setElapsed]=useState(0);
 useEffect(()=>{origin.current=performance.now();setElapsed(0);if(stale||schedule?.observationMode!=='live'||!schedule.scopes.some(s=>s.nodes.some(n=>!n.businessCompleted&&!['unknown','terminated'].includes(n.goalDelta.kind))))return;
  const update=()=>{if(!document.hidden)setElapsed(performance.now()-origin.current);};const timer=setInterval(update,30000);document.addEventListener('visibilitychange',update);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',update);};
 },[schedule,stale]);
 return schedule?new Date(Date.parse(schedule.asOf)+(stale?0:elapsed)).toISOString():undefined;
}
export function observedTargetDelta(progress:ScheduleNodeProgress,asOf?:string):ScheduleGoalDelta{
 return observedGoalDelta(progress.goalDelta,progress.businessCompleted,asOf);
}
function observedGoalDelta(goal:ScheduleGoalDelta,completed:boolean,asOf?:string):ScheduleGoalDelta{
 if(completed||goal.kind==='unknown'||goal.kind==='terminated'||!asOf||!goal.targetAt)return goal;
 const at=Date.parse(asOf);if(!Number.isFinite(at)||at<Date.parse(goal.asOf))return goal;
 const signedValue=goal.unit==='day'&&goal.targetDate?Math.max(0,(Date.parse(new Date(at+8*3600000).toISOString().slice(0,10))-Date.parse(goal.targetDate))/day):Math.max(0,(at-Date.parse(goal.targetAt))/minute);
 return {...goal,signedValue,kind:signedValue>0?'late':'on_target'};
}
/** Present the greatest known delay, never net PO credit against another PO.
 * If no delay is proven, any missing scope keeps the combined number unknown.
 * The title retains every original scope instead of implying one common B. */
export function cockpitTargetDifference(nodes:JourneyNode[],asOf?:string,lines:OrderJourney['lines']=[]){
 const values=[...new Map(nodes.flatMap(node=>node.current&&node.state!=='unavailable'?(node.fixedTargets??[]).map(target=>[target.progress.canonicalWorkRef+'|'+target.scopeRef,{label:node.label,scope:lines.find(line=>line.id===target.lineId)?.po??node.subject??(target.lineId?'对应PO':'本节点范围'),goal:observedTargetDelta(target.progress,asOf)}] as const):[])).values()];
 const known=values.filter(v=>v.goal.signedValue!==null&&!['unknown','terminated'].includes(v.goal.kind));
 const minutes=(goal:ScheduleGoalDelta)=>goal.signedValue!*(goal.unit==='day'?1440:1),late=known.filter(v=>v.goal.kind==='late');
 const chosen=late.sort((a,b)=>minutes(b.goal)-minutes(a.goal))[0]??(known.length===values.length?known.sort((a,b)=>minutes(b.goal)-minutes(a.goal))[0]:undefined);
 const format=(goal:ScheduleGoalDelta)=>goal.signedValue===null?'—':goal.signedValue===0?'-0':`${goal.signedValue>0?'+':'-'}${goal.unit==='day'?Math.abs(goal.signedValue)+'天':cockpitDuration(Math.abs(goal.signedValue))}`;
 return {text:chosen?format(chosen.goal):'—',tone:chosen?(chosen.goal.kind==='late'?'danger':'success'):'neutral',title:values.map(v=>v.label+' · '+v.scope+'：'+format(v.goal)).join('\n'),count:values.length};
}
function differenceUnits(text:string){return text.match(/.*?(?:天|小时|分钟|$)/g)?.filter(Boolean).map((part,index)=><span className="cockpit-delta-unit" key={index}>{part}</span>);}
export function CockpitTargetDifference({nodes,asOf,lines=[],wrapUnits=false}:{nodes:JourneyNode[];asOf?:string|undefined;lines?:OrderJourney['lines'];wrapUnits?:boolean}){const value=cockpitTargetDifference(nodes,asOf,lines);return <span className={'cockpit-target-difference is-'+value.tone} title={value.title||'尚无可信固定目标差'} aria-label={'节点目标差 '+value.text}>{wrapUnits?differenceUnits(value.text):value.text}</span>;}
export function CockpitStageDifference({goal,asOf,wrapUnits=false}:{goal:ScheduleGoalDelta;asOf?:string|undefined;wrapUnits?:boolean}){
 const value=observedGoalDelta(goal,goal.actual.precision!=='unknown',asOf),amount=value.signedValue;
 const text=amount===null?'—':amount===0?'-0':`${amount>0?'+':'-'}${value.unit==='day'?Math.abs(amount)+'天':cockpitDuration(Math.abs(amount))}`;
 return <span className={'cockpit-target-difference is-'+(amount===null?'neutral':amount>0?'danger':'success')} aria-label={'阶段目标差 '+text}>{wrapUnits?differenceUnits(text):text}</span>;
}
export function cockpitOwnStatus(node:JourneyNode):{text:string;tone:'danger'|'warning'|'neutral'}|null{
 if(!node.fixedTargets?.length||['inherited','cancelled','not_applicable','unavailable'].includes(node.state))return null;
 const rows=node.fixedTargets.map(t=>t.progress);if(rows.some(p=>p.ownSla.state==='overdue'))return {text:'逾期（有责口径）',tone:'danger'};
 if(rows.some(p=>p.goalDelta.kind==='late'))return rows.every(p=>p.ownSla.state==='within')?{text:'逾期（无责）',tone:'warning'}:{text:'超目标·待核',tone:'warning'};
 return null;
}
export function CockpitDurationSummary({order,asOf}:{order:OrderJourney;asOf?:string|undefined}){const summary=order.fixedSchedule?.durationSummary,offset=asOf&&summary?.observationAt===summary?.asOf&&order.fixedSchedule?.state!=='terminated'?Math.max(0,(Date.parse(asOf)-Date.parse(summary!.asOf))/minute):0,elapsed=summary?.elapsedSpanMinutes?{minimum:summary.elapsedSpanMinutes.minimum+offset,maximum:summary.elapsedSpanMinutes.maximum+offset}:null;return <div className="cockpit-duration-summary" aria-label="订单总用时"><span>计划总用时：<strong>{cockpitDuration(summary?.planSpanMinutes)}</strong></span><span>已用时间：<strong>{cockpitDurationRange(elapsed)}</strong></span><span>最终实际历时：<strong>{cockpitDurationRange(summary?.finalActualSpanMinutes)}</strong></span></div>;}

export function CockpitFixedTargetDates({node,lines=[]}:{node:JourneyNode;lines?:OrderJourney['lines']}){
 const targets=node.fixedTargets??[];
 return <>{targets.map((target,index)=>{const goal=target.progress.goalDelta,line=lines.find(line=>line.id===target.lineId);return <span className="cockpit-fixed-target-date" key={target.scopeRef+'|'+target.progress.canonicalWorkRef}>{targets.length>1&&<small title={line?`PO ${line.po??'号码待补'} · ${line.color}`:undefined}>{line?`PO ${line.po??'号码待补'} · ${line.color}`:`对应范围${index+1}`}：</small>}{goal.targetPrecision==='date'&&goal.targetDate?<CockpitDate value={goal.targetDate} precision="date"/>:goal.targetAt?<CockpitDate value={goal.targetAt} precision="instant"/>:'待补充'}{Object.hasOwn(target.progress.ownSla,'deadlineAt')&&<small>责任截止：{target.progress.ownSla.deadlineAt?<CockpitDate value={target.progress.ownSla.deadlineAt} precision="instant"/>:scopedDeadlineFallback(node,target)}</small>}</span>;})}</>;
}

/** Actual dates and their adjacent delta share this exact scoped occurrence. */
export function CockpitActualDates({node,lines=[],stacked=false}:{node:JourneyNode;lines?:OrderJourney['lines'];stacked?:boolean}){
 const targets=node.fixedTargets??[],missing=node.state==='completed'?'完成时间待核实':'—';
 if(!targets.length)return <><CockpitDate value={node.actualDate??node.actualAt} precision={node.actualDate?'date':'instant'} missing={missing} stacked={stacked}/>{(node.actualAt||node.actualDate)&&node.actualQuality!=='verified'&&<small>原完成记录，时间待核</small>}</>;
 return <>{targets.map((target,index)=>{const actual=target.progress.goalDelta.actual,line=lines.find(line=>line.id===target.lineId);return <span className="cockpit-fixed-target-date" key={target.scopeRef+'|'+target.progress.canonicalWorkRef}>{targets.length>1&&<small>{line?`PO ${line.po??'号码待补'} · ${line.color}`:`对应范围${index+1}`}：</small>}<CockpitDate value={actual.precision==='instant'?actual.at:actual.precision==='date'?actual.date:null} precision={actual.precision==='date'?'date':'instant'} missing={missing} stacked={stacked}/></span>;})}</>;
}

/** Snapshot of the canonical perPO evaluator, no crossPO arithmetic or client
 * calendar approximation. Numeric buffer keeps the original server asOf. */
export function cockpitScopeProgress(scope:ScheduleScopeProgress|undefined){
 if(!scope)return {text:'待核',tone:'neutral'};
 if(scope.state==='terminated')return {text:'已终止',tone:'neutral'};
 if(scope.nodes.some(node=>node.id.startsWith('garment_packing:')&&node.businessCompleted))return {text:'已交付',tone:'success'};
 if(scope.lagMinutes===null)return {text:scope.state==='late'?'进度落后':'待核',tone:scope.state==='late'?'danger':'neutral'};
 const lag=scope.lagMinutes;if(lag.minimum>0)return {text:'落后'+cockpitDurationRange(lag),tone:'danger'};
 if(lag.maximum>0)return {text:'待核',tone:'neutral'};
 return {text:'可用'+cockpitDurationRange({minimum:-lag.maximum,maximum:-lag.minimum}),tone:'success'};
}
export function cockpitScheduleReason(order:OrderJourney){
 if(!order.fixedSchedule||['completed','closed','cancelled'].includes(order.display?.mainState??''))return null;
 const scope=order.fixedSchedule.scopes.find(scope=>scope.customerDuePassed===true)??order.fixedSchedule.scopes.find(scope=>scope.state==='late');
 if(!scope)return order.fixedSchedule.state==='unknown'?{text:'计划待核',tone:'neutral'}:null;
 const po=order.lines.find(line=>line.id===scope.lineId)?.po;
 return {text:(scope.customerDuePassed?'交期已过':'进度落后')+(po?' · PO '+po:''),tone:scope.customerDuePassed?'danger':'warning'};
}
