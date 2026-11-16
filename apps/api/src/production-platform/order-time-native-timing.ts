import type {ReadyCorrection} from './development-responsibility-window.js';
import type {PoolClient} from 'pg';
import type {FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {FrozenOrderTimePlanSchema,orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {orderTimeAdmission} from './order-time-admission.js';
import {OrderTimePlanRepository,type StoredOrderTimePlan} from './order-time-plan-repository.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';
import type {FixedTimelineCalendar} from './fixed-timeline-targets.js';
import {validateDigitalSlaSnapshot,type DigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';

type DB=Pick<PoolClient,'query'>;
type Timing={timeQuality?:string;enteredAt:string|null;seconds:number|null;warningRatio:number;basis:string[];calendarRef?:FixedTimelineCalendar|null;parameterKey?:string;notificationEnabled?:boolean;orderTimePlanRef?:string};
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
export type OrderTimePolicyVersion={id:string;at:string;plan:FrozenOrderTimePlan;history?:Pick<StoredOrderTimePlan,'input'|'targets'|'revision'|'time'>};
export async function orderTimePolicyHistory(db:DB,resource:{kind:'source'|'order';id:string}):Promise<OrderTimePolicyVersion[]>{
 return (await db.query(`SELECT plan_version_id,input_snapshot,business_time,fixed_targets,revision,identity_hash FROM digital_order_time_plan_versions WHERE resource_kind=$1 AND ${resource.kind==='source'?'source_id':'production_order_id'}=$2 ORDER BY revision DESC`,[resource.kind,resource.id])).rows.map(row=>{
  if(row.input_snapshot.version!=='order-time-input-v1'||fixedTimelineIdentity({input:row.input_snapshot,targets:row.fixed_targets})!==row.identity_hash)throw Error('本单历史时间方案版本或校验不受当前程序支持');
  return {id:String(row.plan_version_id),at:String(row.business_time.now),plan:FrozenOrderTimePlanSchema.parse(row.input_snapshot.plan),history:{input:row.input_snapshot,targets:row.fixed_targets,revision:row.revision,time:row.business_time}};
 });
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
export async function orderTimeNativeTiming(db:DB,task:{task_id:string;task_kind:string;source_id:string|null;production_order_id:string|null;order_time_managed?:boolean;entered_quality?:string;ready_correction?:ReadyCorrection|null},base:Timing|null,enteredAt:string|null,readyCorrection?:{at:string|null;eventId:string},refreshDerivedStart=false):Promise<Timing|null>{
 // The original factory adapter already resolves each exact physical batch
 // at its own R. Its current selected batch cannot be replaced by the first
 // aggregate task revision from an earlier batch.
 if(['process_logistics','bulk_qc','warehouse_dispatch'].includes(task.task_kind))return base;
 const originalCorrection=readyCorrection??task.ready_correction;
 const correctedReady=originalCorrection?{...originalCorrection,at:originalCorrection.at?new Date(originalCorrection.at).toISOString():null}:null;
 if(task.source_id&&base&&correctedReady)base={...base,enteredAt:correctedReady.at,timeQuality:correctedReady.at?'已核实':'缺失',basis:[...base.basis,`ready-correction:${correctedReady.eventId}`]};
 const resource=task.production_order_id?{kind:'order' as const,id:task.production_order_id}:task.source_id?{kind:'source' as const,id:task.source_id}:null;if(!resource)return base;
 if(!task.order_time_managed&&!orderTimeAdmission(db)&&!await new OrderTimePlanRepository(db).current(resource))return base;
 const original=(await db.query(`SELECT entered_at,sla_basis,due_at,warning_at,(SELECT e.time_quality FROM digital_production_task_events e WHERE e.task_id=$1 AND e.event_kind='ready' AND e.occurred_at IS NOT NULL AND coalesce(e.payload->'nativeReadiness'->>'scopeKind','task')='task' ORDER BY e.recorded_at,e.event_id LIMIT 1) AS ready_quality FROM digital_production_deadline_revisions
  WHERE task_id=$1 AND entered_at IS NOT NULL ORDER BY CASE WHEN sla_basis->>'timeQuality' IN ('现场登记','已核实') THEN 0 ELSE 1 END,revision_id LIMIT 1`,[task.task_id])).rows[0];
 const correction=correctedReady;
 // Identity tags describe a route, not proof that responsibility began. A
 // genuinely captured original window survives ordinary later arrangements.
 const trusted=(quality:unknown)=>quality==='现场登记'||quality==='已核实';
 const sameNativeStart=base?.enteredAt&&original?.entered_at&&Date.parse(base.enteredAt)===new Date(original.entered_at).getTime();
 const capturedPolicy=trusted(original?.sla_basis?.timeQuality)||trusted(original?.ready_quality)||!correction&&sameNativeStart&&trusted(task.entered_quality);
 const explicitUnknown=base!==null&&base.enteredAt===null;
 if(original?.sla_basis?.orderTimePlanRef&&(capturedPolicy||base?.enteredAt===null&&!correction)){
  const basis=original.sla_basis;
  const ready=correction?correction.at:explicitUnknown?null:refreshDerivedStart&&base?base.enteredAt:(basis.timeQuality==='缺失'||basis.timeQuality===undefined&&task.source_id&&task.entered_quality!==undefined&&!['现场登记','已核实'].includes(task.entered_quality))&&base?base.enteredAt:new Date(original.entered_at).toISOString();
  return {...base,...basis,enteredAt:ready,timeQuality:ready?(correction?'已核实':base?.timeQuality??'现场登记'):'缺失',basis:[...basis.basis??[],...(correction?[`ready-correction:${correction.eventId}`]:[]),`task:${task.task_id}:original-responsibility`]};
 }
 const ready=correction?correction.at:base!==null?base.enteredAt:original?.entered_at?new Date(original.entered_at).toISOString():enteredAt;
 const chosen=await orderTimePolicyAt(db,resource,ready);if(!chosen)return base;
 // A started legacy task is an existing responsibility, even when its order
 // later receives an explicit time arrangement. Keep that original native D.
 if(original&&!original.sla_basis?.orderTimePlanRef)return base;
 const key=aliases[task.task_kind]??base?.parameterKey??task.task_kind;
 const selected=orderTimeRule(chosen.plan,key);if(!selected)return base;
 const rule=selected.rule,owns=rule.kind==='work'||rule.kind==='included';
 return {...base,parameterKey:key,enteredAt:ready,timeQuality:ready?(correction?'已核实':base?.timeQuality??'现场登记'):'缺失',seconds:owns&&rule.minutes!==null?rule.minutes*60:null,calendarRef:owns?rule.calendar:null,
  warningRatio:rule.reminder.percent/100,notificationEnabled:rule.reminder.enabled,orderTimePlanRef:chosen.id,
  basis:[...base?.basis??[],`order-time:${chosen.id}:${key}`]};
}
