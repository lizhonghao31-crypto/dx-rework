import {COCKPIT_MILESTONE_GROUP, type JourneyNode, type OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {SERIES_MILESTONES,type SeriesMilestoneKey} from '@dx-rework/contracts/digital-series-plan';
import type {JourneyFrameworkScope} from '@dx-rework/contracts/time-framework-journey';
import {CockpitDate} from './cockpit-date.js';
import {CockpitStageDifference, observedGoalDelta} from './cockpit-fixed-schedule.js';
import {CockpitStack} from './cockpit-astryx.js';

export type CockpitMilestone = JourneyFrameworkScope['milestones'][number] & {
 scopeRef: string;
 selectionKey: string;
 label: string;
 directWorkIds: string[];
 prerequisiteIds: string[];
};

export function cockpitMilestoneLabel(key:SeriesMilestoneKey) {
 return key==='planned_shipment'?'出货完成':SERIES_MILESTONES.find(item=>item.key===key)!.label;
}

export function cockpitMilestones(order: OrderJourney): CockpitMilestone[] {
 return (order.fixedSchedule?.framework?.scopes??[]).flatMap(scope=>{
  const projection=order.cockpitStageDates?.find(value=>value.scopeRef===scope.scopeRef
   &&value.planReference===scope.reference&&value.planRevision===scope.revision);
  return scope.milestones.filter(row=>COCKPIT_MILESTONE_GROUP[row.key]
   &&scope.milestones.filter(candidate=>candidate.key===row.key).length===1).map(row=>{
   const members=projection?.milestoneMembers.find(item=>item.key===row.key);
   return {...row,scopeRef:scope.scopeRef,selectionKey:scope.scopeRef+'|'+row.key,
    label:cockpitMilestoneLabel(row.key),
    directWorkIds:members?.workIds??row.workIds,
    prerequisiteIds:members?.prerequisiteIds??(row.relatedWorkIds??[]).filter(id=>!row.workIds.includes(id))};
  });
 }).sort((a,b)=>(a.targetDate===b.targetDate?0:a.targetDate===null?1:b.targetDate===null?-1:a.targetDate.localeCompare(b.targetDate))
  ||SERIES_MILESTONES.findIndex(item=>item.key===a.key)-SERIES_MILESTONES.findIndex(item=>item.key===b.key));
}

export function milestoneContains(milestone: CockpitMilestone, node: JourneyNode, role: 'all'|'direct'|'prerequisite'='all') {
 return node.current&&node.state!=='unavailable'&&node.fixedTargets?.some(target=>{
  if(target.scopeRef!==milestone.scopeRef)return false;
  return (role!=='prerequisite'&&milestone.directWorkIds.includes(target.progress.id))
    ||(role!=='direct'&&milestone.prerequisiteIds.includes(target.progress.id));
 })===true;
}

export function CockpitStageMilestones({items,selected,asOf,onSelect}:{items:CockpitMilestone[];selected:string|undefined;asOf:string|undefined;onSelect:(item:CockpitMilestone)=>void}) {
 return <CockpitStack className="cockpit-stage-milestones" direction="vertical" gap={1}>{items.map(item=><div
  key={item.selectionKey} className="cockpit-stage-milestone" data-milestone-key={item.key}>
  <button type="button" className="journey-text-action" aria-label={item.label+'节点明细'} aria-pressed={selected===item.selectionKey}
   onClick={()=>onSelect(item)}>{item.label}</button><small>里程碑</small>
  <span>预计：<CockpitDate value={item.targetDate} precision="date" missing="待核" short/></span>
  <span>实际：<CockpitDate value={item.actual.precision==='instant'?item.actual.at:item.actual.precision==='date'?item.actual.date:null}
   precision={item.actual.precision==='date'?'date':'instant'} missing={item.completed?'完成时间待核':'未完成'} short/></span>
  {!item.completed&&observedGoalDelta(item.delta,false,asOf).kind==='on_target'
   ?<span>未到期</span>:<CockpitStageDifference goal={item.delta} asOf={asOf}/>}
 </div>)}</CockpitStack>;
}
