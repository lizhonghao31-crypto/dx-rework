import type {PoolClient} from 'pg';
import type {FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {FrozenOrderTimePlanSchema,orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {orderTimeAdmission} from './order-time-admission.js';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
import type {FixedTimelineCalendar} from './fixed-timeline-targets.js';
import {validateDigitalSlaSnapshot,type DigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';

type DB=Pick<PoolClient,'query'>;
type Timing={enteredAt:string|null;seconds:number|null;warningRatio:number;basis:string[];calendarRef?:FixedTimelineCalendar|null;parameterKey?:string;notificationEnabled?:boolean;orderTimePlanRef?:string};
/** Legacy-shaped consumers keep their contract, with the same adopted finite
 * durations. Exact calendars/reminders stay on the native window metadata. */
export function orderTimeSnapshot(snapshot:DigitalSlaSnapshot,plan:FrozenOrderTimePlan):DigitalSlaSnapshot{
 const result=structuredClone(snapshot);
 for(const [key,row]of Object.entries(result.parameters)){
  const rule=orderTimeRule(plan,key)?.rule;if(!rule||rule.minutes===null)continue;
  const same=row.value.kind==='duration'&&rule.kind==='work'||row.value.kind==='included'&&rule.kind==='included'||row.value.kind==='estimate'&&rule.kind==='forecast';
  if(same&&'minutes'in row.value)result.parameters[key]={...row,value:{...row.value,minutes:rule.minutes},source:'order',sourceVersion:plan.revision};
 }
 return validateDigitalSlaSnapshot(result);
}
export async function orderTimePolicyHistory(db:DB,resource:{kind:'source'|'order';id:string}){
 return (await db.query(`SELECT plan_version_id,input_snapshot,business_time FROM digital_order_time_plan_versions WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2 ORDER BY revision DESC`,[resource.kind,resource.id])).rows.map(row=>({id:String(row.plan_version_id),at:String(row.business_time.now),plan:FrozenOrderTimePlanSchema.parse(row.input_snapshot.plan)}));
}
const aliases:Record<string,string>={development_material_recheck:'development_materials',development_craft_confirmation:'development_craft_return',development_external_pattern:'external_pattern',bulk_cutting_external:'bulk_cutting',production_instruction:'production_sheet',factory_production_qc:'factory_production'};
/** Select the original confirmed policy at an actual begun window. A later
 * company publication is never consulted and cannot reset R, quota or D. */
export async function orderTimePolicyAt(db:DB,resource:{kind:'source'|'order';id:string},startedAt:string|null):Promise<{plan:FrozenOrderTimePlan;id:string}|null>{
 const admission=orderTimeAdmission(db);
 const matches=admission&&('sourceId'in admission.operation&&resource.kind==='source'&&admission.operation.sourceId===resource.id||resource.kind==='order'&&admission.generatedOrderId===resource.id||admission.operation.kind==='arrangement'&&admission.operation.resource.kind===resource.kind&&admission.operation.resource.id===resource.id||'orderId'in admission.operation&&resource.kind==='order'&&admission.operation.orderId===resource.id);
 if(matches&&(!startedAt||Date.parse(admission!.time.now)<=Date.parse(startedAt)))return {plan:admission!.plan,id:'order-time-native:'+admission!.activationEventId};
 const row=(await db.query(`SELECT plan_version_id,input_snapshot FROM digital_order_time_plan_versions WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2
  AND ($3::timestamptz IS NULL OR (business_time->>'now')::timestamptz<=$3) ORDER BY revision DESC LIMIT 1`,[resource.kind,resource.id,startedAt])).rows[0];
 return row?{plan:FrozenOrderTimePlanSchema.parse(row.input_snapshot.plan),id:row.plan_version_id as string}:null;
}
export async function orderTimeNativeTiming(db:DB,task:{task_id:string;task_kind:string;source_id:string|null;production_order_id:string|null;order_time_managed?:boolean},base:Timing|null,enteredAt:string|null):Promise<Timing|null>{
 // The original factory adapter already resolves each exact physical batch
 // at its own R. Its current selected batch cannot be replaced by the first
 // aggregate task revision from an earlier batch.
 if(['process_logistics','bulk_qc','warehouse_dispatch'].includes(task.task_kind))return base;
 const resource=task.production_order_id?{kind:'order' as const,id:task.production_order_id}:task.source_id?{kind:'source' as const,id:task.source_id}:null;if(!resource)return base;
 if(!task.order_time_managed&&!orderTimeAdmission(db)&&!await new OrderTimePlanRepository(db).current(resource))return base;
 const original=(await db.query(`SELECT entered_at,sla_basis,due_at,warning_at FROM digital_production_deadline_revisions
  WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY revision_id LIMIT 1`,[task.task_id])).rows[0];
 if(original?.sla_basis?.orderTimePlanRef){
  const basis=original.sla_basis;return {...base,...basis,enteredAt:new Date(original.entered_at).toISOString(),basis:[...basis.basis??[],`task:${task.task_id}:original-responsibility`]};
 }
 const ready=original?.entered_at?new Date(original.entered_at).toISOString():base?.enteredAt??enteredAt;
 const chosen=await orderTimePolicyAt(db,resource,ready);if(!chosen)return base;
 // A started legacy task is an existing responsibility, even when its order
 // later receives an explicit time arrangement. Keep that original native D.
 if(original&&!original.sla_basis?.orderTimePlanRef)return base;
 const key=aliases[task.task_kind]??base?.parameterKey??task.task_kind;
 const selected=orderTimeRule(chosen.plan,key);if(!selected)return base;
 const rule=selected.rule,owns=rule.kind==='work'||rule.kind==='included';
 return {...base,parameterKey:key,enteredAt:ready,seconds:owns&&rule.minutes!==null?rule.minutes*60:null,calendarRef:owns?rule.calendar:null,
  warningRatio:rule.reminder.percent/100,notificationEnabled:rule.reminder.enabled,orderTimePlanRef:chosen.id,
  basis:[...base?.basis??[],`order-time:${chosen.id}:${key}`]};
}
