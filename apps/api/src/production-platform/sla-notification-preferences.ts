import type {Pool,PoolClient} from 'pg';

type Database=Pick<Pool|PoolClient,'query'>;
export type NotificationTask={task_id:string;production_order_id:string|null;source_id:string|null;task_kind:string;sla_basis?:unknown;due_at:Date|string|null};
export type SlaNotificationPreference={warning:boolean;shipSample:boolean};
const original:SlaNotificationPreference={warning:true,shipSample:true};
const uuid=(value:unknown):value is string=>typeof value==='string'&&/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value);
const basis=(task:NotificationTask)=>task.sla_basis&&typeof task.sla_basis==='object'?task.sla_basis as {snapshotId?:unknown;orderTimePlanRef?:unknown;notificationEnabled?:boolean;targets?:Array<{sent?:boolean;dueAt?:string|null;notificationEnabled?:boolean}>}:null;
const preference=(parameters:Record<string,{value?:{notificationEnabled?:boolean}}> |null|undefined):SlaNotificationPreference=>({warning:parameters?.warning_ratio?.value?.notificationEnabled!==false,shipSample:parameters?.ship_sample_advance?.value?.notificationEnabled!==false});

/** Flags follow the same original or explicitly adopted snapshot as the task.
 * Batch reads add no per-order calculation, new recipients or cross-user cache.
 * Old schemas/snapshots keep their original enabled behavior. */
export async function slaNotificationPreferences(db:Database,tasks:readonly NotificationTask[]):Promise<Map<string,SlaNotificationPreference>>{
 const result=new Map(tasks.map(task=>[task.task_id,{...original}]));if(!tasks.length)return result;
 const relations=(await db.query("SELECT to_regclass('digital_sla_order_snapshots') AS snapshots,to_regclass('digital_development_sla_plans') AS sources")).rows[0];
 const orders=[...new Set(tasks.flatMap(task=>task.production_order_id?[task.production_order_id]:[]))],sources=[...new Set(tasks.flatMap(task=>task.source_id?[task.source_id]:[]))],snapshots=[...new Set(tasks.flatMap(task=>uuid(basis(task)?.snapshotId)?[basis(task)!.snapshotId as string]:[]))];
 const orderRows=relations?.snapshots&&(orders.length||snapshots.length)?(await db.query(`SELECT s.snapshot_id,s.production_order_id,s.revision,s.parameters_json,o.source_id FROM digital_sla_order_snapshots s JOIN digital_production_orders o USING(production_order_id)
 WHERE (s.production_order_id=ANY($1::uuid[]) AND s.revision=1) OR s.snapshot_id=ANY($2::uuid[])`,[orders,snapshots])).rows:[];
 const sourceRows=relations?.sources&&sources.length?(await db.query('SELECT source_id,parameters_json FROM digital_development_sla_plans WHERE source_id=ANY($1::uuid[]) AND revision=1',[sources])).rows:[];
 const bySnapshot=new Map(orderRows.map(row=>[row.snapshot_id,row])),byOrder=new Map(orderRows.filter(row=>row.revision===1).map(row=>[row.production_order_id,row])),bySource=new Map(sourceRows.map(row=>[row.source_id,row]));
 for(const task of tasks){
  const candidate=bySnapshot.get(basis(task)?.snapshotId),adopted=candidate&&(task.production_order_id?candidate.production_order_id===task.production_order_id:task.source_id&&candidate.source_id===task.source_id)?candidate:null;
  const row=adopted??(task.production_order_id?byOrder.get(task.production_order_id):null)??(task.source_id?bySource.get(task.source_id):null);
  const flags=preference(row?.parameters_json),own=basis(task);
  result.set(task.task_id,own?.orderTimePlanRef&&typeof own.notificationEnabled==='boolean'?{...flags,warning:own.notificationEnabled}:flags);
 }
 return result;
}
/** Notification selection only: never replaces the task's actual due/warning
 * fields, risk state or PO target. One muted PO cannot mute an enabled sibling. */
export function slaNotificationDue(task:NotificationTask,flags:SlaNotificationPreference=original):Date|string|null{
 if(task.task_kind!=='bulk_ship_sample')return task.due_at;
 const targets=basis(task)?.targets;
 if(!Array.isArray(targets))return flags.shipSample?task.due_at:null;
 const dates=targets.filter(target=>target&&typeof target==='object'&&!target.sent&&(target.notificationEnabled??flags.shipSample)&&typeof target.dueAt==='string'&&Number.isFinite(Date.parse(target.dueAt))).map(target=>target.dueAt!).sort((a,b)=>Date.parse(a)-Date.parse(b));
 return dates[0]??null;
}
