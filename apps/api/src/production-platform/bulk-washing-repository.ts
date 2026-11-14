import {assertWholeOrderActive} from './whole-order-visibility.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {BulkWashingAdoptionSchema,type BulkWashingAdoption,type BulkWashingFact} from '@dx-rework/contracts/bulk-washing';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
export type WashingDB=Pick<Pool|PoolClient,'query'>;
export const washingConflict=(message:string):never=>{throw new ApplicationError('BULK_WASHING_CONFLICT',message,409);};
export const washingHash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type WashingPlan={id:string;orderId:string;lineId:string;version:number;document:BulkWashingAdoption};
export async function washingPlans(db:WashingDB,orderId:string):Promise<WashingPlan[]>{
 return (await db.query('SELECT * FROM digital_bulk_washing_plans WHERE production_order_id=$1 ORDER BY version,plan_id',[orderId])).rows
  .map(row=>({id:row.plan_id,orderId:row.production_order_id,lineId:row.line_id,version:row.version,document:BulkWashingAdoptionSchema.parse(row.document)}));
}
export type WashingEvent={id:string;planId:string;scopeId:string;quantityVersion:string;sequence:number;kind:string;payload:Record<string,unknown>;occurredAt:string|null;recordedAt:string;operator:string};
export async function washingEvents(db:WashingDB,orderId:string):Promise<WashingEvent[]>{
 return (await db.query(`SELECT e.*,u.display_name FROM digital_bulk_washing_events e JOIN app_users u ON u.id=e.actor_id
  WHERE production_order_id=$1 ORDER BY scope_id,sequence`,[orderId])).rows.map(r=>({id:r.event_id,planId:r.plan_id,scopeId:r.scope_id,quantityVersion:r.quantity_version,
   sequence:r.sequence,kind:r.kind,payload:r.payload,occurredAt:r.occurred_at?new Date(r.occurred_at).toISOString():null,recordedAt:new Date(r.recorded_at).toISOString(),operator:r.display_name}));
}
export function washingFact(event:WashingEvent):BulkWashingFact{
 return {...event.payload,id:event.id,scopeId:event.scopeId,quantityVersion:event.quantityVersion,occurredAt:event.occurredAt,kind:event.kind} as BulkWashingFact;
}
export async function washingOrderActive(db:WashingDB,orderId:string){
 await assertWholeOrderActive(db,'order',orderId);
 const order=(await db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0];
 if(!order)washingConflict('订单不存在');
 if(order.source_id)await assertWholeOrderActive(db,'source',order.source_id);
 return !(await db.query(`SELECT 1 FROM digital_order_closures WHERE production_order_id=$1 UNION ALL SELECT 1
  FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1 OR resource_kind='source' AND resource_id=$2) AND state<>'active'`,[orderId,order.source_id])).rowCount;
}
/** Only called inside an authorized original adoption/change transaction.
 * No public route exposes an alternate configuration or approval mechanism. */
export async function adoptBulkWashingWithClient(db:PoolClient,actor:TrustedActorContext,orderId:string,lineId:string,expectedVersion:number,value:BulkWashingAdoption){
 const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'order',orderId,'technical');
 const leader=isRootActor(actor)||await policy.lockActiveRole(actor.actorId,'owner_group')||await policy.lockActiveRole(actor.actorId,'production_management');
 if(!leader)digitalForbidden();
 await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
 if(!await washingOrderActive(db,orderId))washingConflict('订单已终止或结案，不能采用新洗水安排');
 if(!(await db.query('SELECT 1 FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2',[orderId,lineId])).rowCount)washingConflict('洗水PO不属于本单');
 const document=BulkWashingAdoptionSchema.parse(value);
 if(document.staff)for(const [id,role]of [[document.staff.logisticsId,'embroidery_washing_merchandiser'],[document.staff.inspectorId,'quality_control']])
  if(!await policy.lockActiveRole(id!,role!))washingConflict('洗水办理人员已停用或岗位不符');
 if(document.fee.kind==='budget_row'){
  const budget=(await db.query('SELECT document FROM digital_budget_versions WHERE production_order_id=$1 AND version=$2',[orderId,document.fee.version])).rows[0];
  const rowId=document.fee.rowId;
  if(!budget?.document.rows.some((row:{rowId:string;section:string})=>row.rowId===rowId&&row.section==='外发工序'))washingConflict('洗水费用须引用本单已发布预算的外发工序行');
 }
 const prior=(await db.query('SELECT version FROM digital_bulk_washing_plans WHERE production_order_id=$1 AND line_id=$2 ORDER BY version DESC LIMIT 1',[orderId,lineId])).rows[0];
 if((prior?.version??0)!==expectedVersion)washingConflict('本单洗水安排已更新，请重新读取');
 const id=randomUUID();await db.query('INSERT INTO digital_bulk_washing_plans(plan_id,production_order_id,line_id,version,document,created_by) VALUES($1,$2,$3,$4,$5,$6)',[id,orderId,lineId,expectedVersion+1,JSON.stringify(document),actor.actorId]);
 await db.query('UPDATE digital_production_po_lines SET bulk_washing_plan_id=$2 WHERE line_id=$1',[lineId,id]);
 // Adoption and its disposable coverage move together under the original
 // lifecycle transaction lock. Started scopes still read their frozen plan;
 // new assignees/fees/durations cannot invalidate unchanged physical evidence.
 const {readBulkWashing}=await import('./bulk-washing-service.js');
 const {refreshBulkWashingCoverage}=await import('./bulk-washing-coverage.js');
 await refreshBulkWashingCoverage(db,orderId,await readBulkWashing(db,orderId,null));
 return {id,version:expectedVersion+1};
}
