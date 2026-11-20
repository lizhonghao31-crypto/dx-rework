import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {SERIES_MILESTONES} from '@dx-rework/contracts/digital-series-plan';
import type {JourneyFrameworkScope} from '@dx-rework/contracts/time-framework-journey';
import {CockpitDate} from './cockpit-date.js';
import {CockpitStageDifference,observedGoalDelta} from './cockpit-fixed-schedule.js';

export type CockpitMilestone=JourneyFrameworkScope['milestones'][number]&{scopeRef:string;lineId:string|null;route:'A'|'B';selectionKey:string;label:string};
/** Match the authorized projection's exact work and scope, never a stage alias.
 * A shared task remains one row even when several milestones reference it. */
export function cockpitMilestones(order:OrderJourney):CockpitMilestone[]{
 return (order.fixedSchedule?.framework?.scopes??[]).flatMap(scope=>scope.milestones.map(row=>({...row,scopeRef:scope.scopeRef,lineId:scope.lineId,route:scope.route,selectionKey:scope.scopeRef+'|'+row.key,label:row.key==='planned_shipment'?'出货完成':SERIES_MILESTONES.find(item=>item.key===row.key)!.label}))).sort((a,b)=>a.targetDate.localeCompare(b.targetDate)||SERIES_MILESTONES.findIndex(item=>item.key===a.key)-SERIES_MILESTONES.findIndex(item=>item.key===b.key));
}
export function milestoneContains(milestone:CockpitMilestone,node:JourneyNode){
 return node.current&&node.state!=='unavailable'&&node.fixedTargets?.some(target=>target.scopeRef===milestone.scopeRef&&(milestone.relatedWorkIds??milestone.workIds).includes(target.progress.id))===true;
}
export function CockpitMilestoneFlow({items,selected,onSelect,asOf,lines}:{items:CockpitMilestone[];selected:string|undefined;onSelect:(item:CockpitMilestone)=>void;asOf:string|undefined;lines:OrderJourney['lines']}){
 return <div className="cockpit-flow-scroll" role="region" aria-label="里程碑横向流程" tabIndex={0}><div className="cockpit-stages cockpit-milestones" style={{gridTemplateColumns:`repeat(${items.length}, minmax(var(--cockpit-milestone-min,112px), 1fr))`}}>{items.map((item,index)=>{
  const actual=item.actual,po=lines.find(line=>line.id===item.lineId),multi=new Set(items.map(row=>row.scopeRef)).size>1;
  return <div key={item.selectionKey} className={`cockpit-stage${selected===item.selectionKey?' is-selected':''} is-${item.delta.kind==='late'?'danger':item.completed?'success':'neutral'}`}>
   <button type="button" className="cockpit-stage-select" aria-pressed={selected===item.selectionKey} aria-label={`${item.label}${multi&&po?' · '+po.po:''}节点明细`} onClick={()=>onSelect(item)}>
    <span className="cockpit-stage-rings"><svg viewBox="0 0 104 104" aria-hidden="true"><circle cx="52" cy="52" r="46" className="cockpit-stage-track" fill="none" strokeWidth="6"/><circle cx="52" cy="52" r="35" className={item.completed?'cockpit-stage-arc is-actual':'cockpit-stage-track'} fill="none" strokeWidth="4"/><text x="52" y="62" textAnchor="middle" fontSize="30" fontWeight="700">{item.completed?'✓':index+1}</text></svg></span><strong>{item.label}</strong>{multi&&<small>{po?.po??'本单'} · {item.route==='A'?'要对色':'无需对色'}</small>}
   </button>
   <div className="cockpit-stage-dates"><div><span>预计</span><CockpitDate value={item.targetDate} precision="date" short/></div><div><span>实际</span><CockpitDate value={actual.precision==='instant'?actual.at:actual.precision==='date'?actual.date:null} precision={actual.precision==='date'?'date':'instant'} missing={item.completed?'时间待核':'未完成'} short/></div><div><span>差异</span>{!item.completed&&observedGoalDelta(item.delta,false,asOf).kind==='on_target'?<span>未到期</span>:<CockpitStageDifference goal={item.delta} asOf={asOf}/>}</div></div>
  </div>;
 })}</div></div>;
}
