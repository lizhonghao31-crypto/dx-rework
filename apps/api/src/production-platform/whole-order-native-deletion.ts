import {invalidatePackingAliasCandidates} from '../receiving/packing-alias-invalidation.js';
import type {PoolClient} from 'pg';
import {MessageOutboxRepository,OperationEventRepository,type TrustedActorContext} from '../tools/repositories.js';
import type {WholeOrderScope} from './whole-order-deletion-scope.js';

/** Reuse each native module's deletion/exclusion audit contract, in the
 * caller-owned whole-order transaction. Never call independent HTTP mutations. */
export async function deleteWholeOrderNative(db:PoolClient,actor:TrustedActorContext,scope:WholeOrderScope){
 const events=new OperationEventRepository(),reason='Root 删除整单，保留历史记录';
 const event=(capability:string,action:string,entityType:string,id:string,before:unknown,after:unknown)=>events.append(db,{...actor,authorizationCapability:capability},{action,entityType,entityId:id,before,after,reason});
 for(const item of scope.objects){
  if(item.kind==='sourcing'){
   const row=(await db.query('SELECT * FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE',[item.id])).rows[0];if(!row||row.deleted_at)continue;
   const audit=await event('sourcing:delete','sourcing.case.delete','sourcing_case',item.id,row,{deleted:true});
   await db.query(`UPDATE sourcing_cases SET deleted_at=clock_timestamp(),deleted_by=$2,deletion_operation_event_id=$3,deletion_request_id=$4,deletion_reason=$5 WHERE sourcing_case_id=$1`,[item.id,actor.actorId,audit,actor.requestId,reason]);
  }
  if(item.kind==='pattern_room'){
   const row=(await db.query('SELECT * FROM pattern_room_orders WHERE order_id=$1 FOR UPDATE',[item.id])).rows[0];if(!row||row.deleted_at)continue;
   const audit=await event('pattern_room:orders:delete','pattern_room.order.deleted','pattern_room_order',item.id,row,{orderId:item.id,roundId:row.current_round_id,value:{deleted:true}});
   await db.query(`UPDATE pattern_room_orders SET deleted_at=clock_timestamp(),deleted_by=$2,deletion_event_id=$3,version=version+1,updated_at=clock_timestamp() WHERE order_id=$1`,[item.id,actor.actorId,audit]);
   await db.query(`UPDATE pattern_room_node_times SET exited_at=clock_timestamp(),exit_reason='cancelled' WHERE exited_at IS NULL AND round_id IN(SELECT round_id FROM pattern_room_rounds WHERE order_id=$1)`,[item.id]);
  }
  if(item.kind==='production'){
   const row=(await db.query('SELECT * FROM sourcing_production_orders WHERE production_order_id=$1 FOR UPDATE',[item.id])).rows[0];
   if(!row||(await db.query('SELECT 1 FROM sourcing_production_exclusions WHERE production_order_id=$1',[item.id])).rowCount)continue;
   await db.query("SELECT pg_advisory_xact_lock(hashtext('production-closure'))");
   const audit=await event('sourcing:production:view','sourcing.production.exclude','sourcing_production_order',item.id,row,{productionOrderId:item.id,excluded:true,previewVersion:scope.revision,reason});
   await db.query('INSERT INTO sourcing_production_exclusions(production_order_id,preview_version,reason,excluded_by,operation_event_id) VALUES($1,$2,$3,$4,$5)',[item.id,scope.revision,reason,actor.actorId,audit]);
   await db.query('UPDATE sourcing_production_alerts SET resolved_at=clock_timestamp() WHERE production_order_id=$1 AND resolved_at IS NULL',[item.id]);
  }
  if(item.kind==='rework'){
   const row=(await db.query('SELECT * FROM rework_orders WHERE rework_order_id=$1 FOR UPDATE',[item.id])).rows[0];if(!row||row.status==='deleted')continue;
   const audit=await event('rework:delete','rework.delete','rework_order',item.id,row,{reworkOrderId:row.rework_order_id,reworkNo:row.rework_no,status:'deleted',styleNo:row.style_no,orderNo:row.order_no,merchandiserUserId:row.merchandiser_user_id,
    processingFactory:row.processing_factory_type===null?null:row.processing_factory_type==='own_factory'?{type:'own_factory'}:{type:'supplier',supplierId:row.processing_factory_supplier_id,supplierVersion:row.processing_factory_supplier_version},
    problemPart:row.problem_part,problemDescription:row.problem_description,reworkQuantity:row.rework_quantity,deletedBy:actor.actorId,version:row.version+1});
   await db.query("SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",[audit,actor.requestId]);
   await db.query(`UPDATE rework_orders SET status='deleted',deleted_at=clock_timestamp(),deleted_by=$2,updated_by=$2,version=version+1,updated_at=clock_timestamp() WHERE rework_order_id=$1`,[item.id,actor.actorId]);
   await new MessageOutboxRepository().enqueue(db,{topic:'rework.deleted',aggregateType:'rework_order',aggregateId:item.id,payload:{reworkOrderId:item.id,reworkNo:row.rework_no},recipientKey:'system:rework',idempotencyKey:`${item.id}:deleted:${row.version+1}`});
  }
 }
 // Rework children are already logically deleted above. Only the exact batch
 // registered in this deletion scope may use the whole-order exception.
 for(const item of scope.objects.filter(row=>row.kind==='receiving_batch')){
  const row=(await db.query('SELECT * FROM receiving_batches WHERE receiving_batch_id=$1 FOR UPDATE',[item.id])).rows[0];if(!row||row.deleted_at)continue;
  const audit=await event('receiving:correct','receiving.batch.delete','receiving_batch',item.id,row,{receivingBatchId:item.id,version:row.version+1,deleted:true});
  await db.query("SELECT set_config('dx_rework.receiving_root_action','delete',true)");
  await db.query(`UPDATE receiving_batches SET deleted_at=clock_timestamp(),deleted_by=$2,updated_by=$2,updated_at=clock_timestamp(),version=version+1,last_operation_event_id=$3,last_request_id=$4 WHERE receiving_batch_id=$1`,[item.id,actor.actorId,audit,actor.requestId]);
  await invalidatePackingAliasCandidates(db,[row.style_no]);
 }
}
