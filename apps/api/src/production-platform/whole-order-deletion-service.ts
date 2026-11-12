import {deleteWholeOrderNative} from './whole-order-native-deletion.js';
import {OperationEventRepository} from '../tools/repositories.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {TodoService} from '../todos/service.js';
import {wholeOrderScope} from './whole-order-deletion-scope.js';
import {WholeOrderDeletionInputSchema,WholeOrderSelectionSchema,type WholeOrderDeletionPreview,type WholeOrderDeletionResult} from '@dx-rework/contracts/whole-order-deletion';

export class WholeOrderDeletionService{
 constructor(private readonly database:Pool){}
 private async authorize(db:Pick<PoolClient,'query'>,actor:TrustedActorContext){
  if(!isRootActor(actor)||!(await db.query('SELECT access_is_root_actor($1) AS allowed',[actor.actorId])).rows[0]?.allowed)
   throw new ApplicationError('FORBIDDEN','仅 Root 可以删除整单',403);
 }
 async preview(actor:TrustedActorContext,input:unknown):Promise<WholeOrderDeletionPreview>{
  const {ids}=WholeOrderSelectionSchema.parse(input),db=await this.database.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.authorize(db,actor);
   const orders:WholeOrderDeletionPreview['orders']=[],seen=new Set<string>();
   for(const id of [...new Set(ids)]){
    const scope=await wholeOrderScope(db,id);if(seen.has(scope.id))continue;seen.add(scope.id);
    await acceptanceBusinessContext()?.assertScope({kind:scope.orderId?'order':'source',id:scope.id});
    const deleted=Boolean((await db.query('SELECT 1 FROM digital_whole_order_deletions WHERE source_id=$1 OR production_order_id=$2',[scope.sourceId,scope.orderId])).rowCount);
    orders.push({id:scope.id,sourceId:scope.sourceId,orderId:scope.orderId,label:scope.label,customer:scope.customer,poCount:scope.poCount,revision:scope.revision,counts:scope.counts,deleted});
   }
   await db.query('COMMIT');return {orders};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async remove(actor:TrustedActorContext,input:unknown,key:string):Promise<WholeOrderDeletionResult>{
  const parsed=WholeOrderDeletionInputSchema.parse(input);
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效操作标识，请重试',400);
  await this.authorize(this.database,actor);
  const inputHash=createHash('sha256').update(JSON.stringify(parsed)).digest('hex');
  await this.database.query(`INSERT INTO digital_whole_order_delete_requests(actor_id,idempotency_key,input_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[actor.actorId,key,inputHash]);
  const saved=(await this.database.query('SELECT input_hash FROM digital_whole_order_delete_requests WHERE actor_id=$1 AND idempotency_key=$2',[actor.actorId,key])).rows[0];
  if(saved?.input_hash!==inputHash)throw new ApplicationError('IDEMPOTENCY_CONFLICT','本次操作内容已变化，请重新核对关联范围',409);
  const results:WholeOrderDeletionResult['results']=[];
  for(const item of [...new Map(parsed.orders.map(row=>[row.id,row])).values()]){
   const db=await this.database.connect();
   let commitAttempted=false;
   try{
    await db.query('BEGIN');
    // Serialize with original creation/adoption/task commands before resolving
    // children; native rows are subsequently locked in stable identity order.
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    // Serialize current Root eligibility with local deactivation/identity changes.
    await db.query(`SELECT u.id FROM app_users u JOIN owner_bootstrap_consumptions b ON b.user_id=u.id
     JOIN identity_mappings i ON i.user_id=u.id AND i.provider='dingtalk' AND i.provider_user_id=b.provider_user_id AND i.corp_id=b.corp_id
     JOIN access_security_policy p ON p.policy_key='primary' WHERE u.id=$1 FOR SHARE OF u,b,i,p`,[actor.actorId]);
    await this.authorize(db,actor);
    let scope=await wholeOrderScope(db,item.id);
    await acceptanceBusinessContext()?.assertScope({kind:scope.orderId?'order':'source',id:scope.id});
    if(scope.orderId)await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[scope.orderId]);
    if(scope.sourceId)await db.query('SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE',[scope.sourceId]);
    // Native child creation locks its parent too. Acquire these before the
    // second scope read so a concurrent native child is included or rejected.
    await db.query('SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=ANY($1::uuid[]) ORDER BY sourcing_case_id FOR UPDATE',[scope.objects.filter(row=>row.kind==='sourcing').map(row=>row.id)]);
    // Use the same native receipt-group locks before collecting downstream
    // receipts/reworks, so concurrent append/packing cannot escape the preview.
    for(const cut of scope.objects.filter(row=>row.kind==='cutting'))await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`cutting:${cut.id}`]);
    await db.query(`SELECT b.receiving_batch_id FROM receiving_batches b WHERE EXISTS(SELECT 1 FROM receiving_receipts r WHERE r.receiving_batch_id=b.receiving_batch_id AND r.receipt_id=ANY($1::uuid[])) ORDER BY b.receiving_batch_id FOR UPDATE`,[scope.objects.filter(row=>row.kind==='receiving').map(row=>row.id)]);
    scope=await wholeOrderScope(db,item.id);
    const prior=(await db.query('SELECT deletion_id FROM digital_whole_order_deletions WHERE source_id=$1 OR production_order_id=$2',[scope.sourceId,scope.orderId])).rows[0];
    if(prior){await db.query('COMMIT');results.push({id:item.id,status:'already_deleted'});continue;}
    const receiptIds=scope.objects.filter(row=>row.kind==='receiving').map(row=>row.id);
    const shared=(await db.query(`SELECT 1 FROM receiving_receipts own JOIN receiving_receipts other USING(receiving_batch_id)
     WHERE own.receipt_id=ANY($1::uuid[]) AND NOT(other.receipt_id=ANY($1::uuid[])) LIMIT 1`,[receiptIds])).rowCount;
    if(shared)throw new ApplicationError('CONFLICT','本单回货与其他订单共用批次，尚不能安全拆分删除；本单未删除',409);
    if(scope.revision!==item.revision)throw new ApplicationError('CONFLICT','订单或关联范围已变化，请重新确认后删除',409);
    const deletionId=randomUUID();
    const operationEventId=await new OperationEventRepository().append(db,actor,{
     action:'digital.whole_order.delete',entityType:'digital_production',entityId:scope.id,
     before:scope,after:{deletionId,revision:scope.revision,historyRetained:true},reason:'Root 删除整单，保留历史记录'
    });
    await db.query(`INSERT INTO digital_whole_order_deletions(deletion_id,source_id,production_order_id,actor_id,request_id,idempotency_key,preview_revision,scope_json,operation_event_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[deletionId,scope.sourceId,scope.orderId,actor.actorId,actor.requestId,key,item.revision,JSON.stringify(scope),operationEventId]);
    await db.query(`INSERT INTO digital_whole_order_deleted_objects(object_kind,object_id,deletion_id)
     SELECT kind,id,$2 FROM jsonb_to_recordset($1::jsonb) AS x(kind text,id uuid)`,[JSON.stringify(scope.objects),deletionId]);
    await deleteWholeOrderNative(db,actor,scope);
    const taskIds=scope.objects.filter(row=>row.kind==='task').map(row=>row.id);
    await db.query(`UPDATE digital_production_tasks SET state='cancelled',terminal_recorded_at=clock_timestamp()
     WHERE task_id=ANY($1::uuid[]) AND state NOT IN ('completed','cancelled')`,[taskIds]);
    for(const resource of scope.objects.filter(row=>row.kind==='source'||row.kind==='order')){
     await db.query(`INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by,reason)
      VALUES($1,$2,'cancelled',$3,'Root 删除整单') ON CONFLICT(resource_kind,resource_id)
      DO UPDATE SET state='cancelled',changed_by=EXCLUDED.changed_by,changed_at=clock_timestamp(),reason=EXCLUDED.reason`,[resource.kind,resource.id,actor.actorId]);
     await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
      SELECT $1,$2,$3,'cancel',$4,deleted_at,'现场登记',jsonb_build_object('reason','Root 删除整单','deletionId',deletion_id)
      FROM digital_whole_order_deletions WHERE deletion_id=$5`,[randomUUID(),resource.kind,resource.id,actor.actorId,deletionId]);
     await db.query(`INSERT INTO digital_journey_fact_changes(resource_kind,resource_id,reason) VALUES($1,$2,'native') ON CONFLICT DO NOTHING`,[resource.kind,resource.id]);
    }
    const todos=new TodoService(this.database);
    for(const object of scope.objects){
     if(object.kind==='sourcing')await todos.cancelOpenByDedupePrefix(db,actor,`sourcing:${object.id}:`,'订单已删除');
     if(object.kind==='pattern_room')await todos.cancelOpenByDedupePrefix(db,actor,`pattern-room:${object.id}:`,'订单已删除');
     if(object.kind==='rework')await todos.cancelOpenForReworkOrder(db,actor,object.id,'订单已删除');
    }
    await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
     VALUES($1,$2,$3,'whole_order_deleted','digital_production',$4,$5,$6)`,[randomUUID(),actor.requestId,actor.actorId,scope.id,JSON.stringify(scope),JSON.stringify({deleted:true,deletionId,historyRetained:true})]);
    commitAttempted=true;await db.query('COMMIT');results.push({id:item.id,status:'deleted'});
   }catch(error){
    await db.query('ROLLBACK').catch(()=>undefined);
    results.push({id:item.id,status:commitAttempted?'unknown':'failed',message:commitAttempted?'删除结果尚未确认，请核对后重试':error instanceof ApplicationError?error.message:'本单未删除，请重试'});
   }finally{db.release();}
  }
  return {results};
 }
}
