import type {FrozenInitialTimelineInput} from './fixed-timeline-initial-input.js';
import type {FixedTimelineCalendar} from './fixed-timeline-targets.js';
import {orderTimeRule,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {DIGITAL_SLA_PARAMETERS} from '@dx-rework/contracts/digital-sla';

/** Old snapshots keep their original split inputs. An explicit new order plan
 * supplies one ordinary-node duration/calendar to planning and responsibility.
 */
export type FixedWorkInputs={data:Pick<FrozenInitialTimelineInput['data'],'unified'|'planning'|'development'|'orderTimePlan'>};
export function frozenWorkDefinition(initial:FixedWorkInputs,key:string,dualCraft=false){
 if(initial.data.orderTimePlan)return orderTimeWorkDefinition(initial.data.orderTimePlan,key);
 const parameter=initial.data.unified.values.parameters[key]?.value;
 const adopted=initial.data.planning?.values[key] as {minutes?:number;calendar?:FixedTimelineCalendar;responsibilityAdopted?:boolean;responsibilityMinutes?:number;responsibilityCalendar?:FixedTimelineCalendar}|undefined;
 const ref=initial.data.planning?`${initial.data.planning.standardRef}:${key}`:null;
 const own=parameter?.kind==='duration'||parameter?.kind==='included',originalMinutes=parameter&&'minutes'in parameter?parameter.minutes:null;
 return {
  minutes:adopted?.minutes??(dualCraft?null:originalMinutes),
  calendar:adopted?.calendar??(dualCraft||originalMinutes===null?null:'continuous' as const),
  planningParameterRef:adopted?ref:!dualCraft&&originalMinutes!==null?`${initial.data.unified.snapshotRef}:${key}`:null,
  responsibilitySlaRef:dualCraft?(adopted?.responsibilityAdopted?ref:null):own?`${initial.data.unified.snapshotRef}:${key}`:null,
  responsibilityMinutes:dualCraft?(adopted?.responsibilityAdopted?adopted.responsibilityMinutes??null:null):own?originalMinutes:null,
  responsibilityCalendar:dualCraft?(adopted?.responsibilityAdopted?adopted.responsibilityCalendar??null:null):own?'continuous' as const:null,
 };
}

/** Single adopted value for new plans; old snapshots do not enter this branch. */
export function orderTimeWorkDefinition(plan:FrozenOrderTimePlan,key:string){
  const selected=orderTimeRule(plan,key),rule=selected?.rule;
  const reference=selected?`${selected.reference}:order-time:${selected.revision}:${selected.source}:${key}`:null;
  const owns=rule?.kind==='work'||rule?.kind==='included';
  return {minutes:rule?.kind==='supervision'?0:rule?.minutes??null,
   calendar:rule?.minutes===0||rule?.kind==='supervision'?'continuous' as const:rule?.calendar??null,
   planningParameterRef:reference,responsibilitySlaRef:owns?reference:null,
   responsibilityMinutes:owns?rule.minutes:null,responsibilityCalendar:owns?rule.calendar:null};

}

/** The one existing shared reserve is charged on a real cross-stage edge.
 * Parallel predecessors receive the same gap and are joined by max, not sum.
 */
export function orderTimeDependencyReserves(node:{stage:number;dependsOn:readonly string[]},byId:ReadonlyMap<string,{stage:number}>,minutes:number){
 return Object.fromEntries(node.dependsOn.filter(id=>{const dep=byId.get(id);if(!dep)throw Error('本单缺少真实前序');return dep.stage!==node.stage;}).map(id=>[id,{minutes,calendar:'continuous' as const}]));
}

/** Original native builders and the independent calculator use the same edge
 * accounting once an explicit new policy is present. Legacy snapshots stay exact.
 */
export function withOrderTimeStageReserves<T extends {id:string;parameterKey?:string;dependsOn:readonly string[];stage?:number;includedIn?:string;calendar?:FixedTimelineCalendar|null;responsibilitySlaRef?:string|null}>(initial:FixedWorkInputs,work:T[]):T[]{
 const plan=initial.data.orderTimePlan;if(!plan)return work;
 const catalog=new Map(DIGITAL_SLA_PARAMETERS.map(value=>[value.key,value.stage]));
 const staged=work.map(node=>{const stage=node.stage??catalog.get(node.parameterKey??node.id)??(node.parameterKey==='factory_production_work'?6:['source_confirmation','development_confirmation'].includes(node.parameterKey??node.id)?2:null);if(!stage)throw Error('适用节点阶段尚未明确');return {...node,stage};});
 const byId=new Map(staged.map(node=>[node.id,node])),buffer=plan.stageBufferMinutes??plan.company.stageBufferMinutes;
 return staged.map(node=>{const parent=node.includedIn?byId.get(node.includedIn):null;return {...node,
  ...(parent?{calendar:parent.calendar??null,...(node.responsibilitySlaRef?{responsibilityCalendar:parent.calendar??null}:{})}:{}),
  dependencyReserves:buffer?orderTimeDependencyReserves(node,byId,buffer):undefined};});
}
