import type {OrderTimeWashingReworkChanges} from '@dx-rework/contracts/order-time-washing-rework';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {orderTimeGapText,OrderTimeOperationSchema,OrderTimeRequestSchema,OrderTimeApplySchema,OrderTimeArrangementSchema,OrderTimeReturnSchema,OrderTimeWithdrawSchema,type OrderTimeOperation,type OrderTimeRequestRead,type OrderTimeWashingChanges} from '@dx-rework/contracts/order-time-requests';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {ContextBusinessClock,observedBusinessTime,businessNow} from '../acceptance-clock/business-time.js';
import {isRootActor} from '../access/business-authority.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {assertSlaSettingsActor} from './sla-settings-authority.js';
import {loadOrderTimeOperation,orderTimeOperationScope} from './order-time-operation-state.js';
import {refreshLinkedOrderTimeInput} from './order-time-linked-applicability.js';
import {withinOrderTimeAdmission,orderTimeRequester} from './order-time-admission.js';
import {OrderTimeRequestRepository,type OrderTimeRequestRow} from './order-time-request-repository.js';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
import {currentOrderTimeOperation} from './order-time-native-commands.js';
import {adoptBulkWashingWithClient} from './bulk-washing-repository.js';
import {DigitalProductionTaskService} from './task-service.js';

export type OrderTimeNativeExecutor=(db:PoolClient,actor:TrustedActorContext,operation:OrderTimeOperation,key:string)=>Promise<{sourceId:string|null;orderId:string|null}>;
const conflict=(code:string,message:string):never=>{throw new ApplicationError(code,message,409);};
export {orderTimeGapText} from '@dx-rework/contracts/order-time-requests';

/** One original lifecycle transaction covers request decision, native business
 * publication, selected policy and receipts. The real manager stays the actor. */
export class OrderTimeRequestService{
 constructor(private readonly database:Pool,private readonly execute:OrderTimeNativeExecutor){}
 private async transaction<T>(write:boolean,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  const db=await this.database.connect();try{
   await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(write)await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const result=await work(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async time(db:PoolClient,operation:OrderTimeOperation):Promise<BusinessTime>{
  const scope=orderTimeOperationScope(operation);return scope?new ContextBusinessClock(this.database,db).read(scope):observedBusinessTime(businessNow);
 }
 private async visible(db:PoolClient,actor:TrustedActorContext,id:string,lock=false){
  const row=await new OrderTimeRequestRepository(db).read(id,lock);if(!row)digitalNotFound();
  if(row!.source_id)await new DigitalProductionAccessPolicy(db).assert(actor,'source',row!.source_id,'technical');
  else if(row!.production_order_id)await new DigitalProductionAccessPolicy(db).assert(actor,'order',row!.production_order_id,'technical');
  if(actor.actorId!==row!.designer_id&&actor.actorId!==row!.requested_by)await assertSlaSettingsActor(db,actor,lock);
  else if(!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,actor.actorId===row!.designer_id?'sample_designer':'order_merchandiser'))digitalForbidden();
  return row!;
 }
 private async result(db:PoolClient,actor:TrustedActorContext,row:OrderTimeRequestRow,changes:Record<string,OrderTimeRule>={},washing:OrderTimeWashingChanges=[],rewashing:OrderTimeWashingReworkChanges=[]):Promise<OrderTimeRequestRead>{
  // Publication can consume a revision draft or create a new native source.
  // Its receipt must read the committed result, not require the old draft again.
  const target=row.state==='applied'&&row.applied_plan_id?(await db.query('SELECT resource_kind,source_id,production_order_id FROM digital_order_time_plan_versions WHERE plan_version_id=$1',[row.applied_plan_id])).rows[0]:null;
  const operation:OrderTimeOperation=target?{kind:'arrangement',resource:{kind:target.resource_kind,id:target.resource_kind==='source'?target.source_id:target.production_order_id}}:await currentOrderTimeOperation(db,row.operation_json);
  const state=await loadOrderTimeOperation(this.database,db,actor,operation,await this.time(db,operation),changes,washing,rewashing);
  return {requestId:row.request_id,version:row.version,state:row.state,operation,requestedBy:{id:row.requested_by,name:row.requested_name??null},designerId:row.designer_id,reason:row.reason,returnReason:row.return_reason,
   appliedBy:row.applied_by?{id:row.applied_by,name:row.applied_name??null}:null,result:row.state==='applied'?{orderId:row.result_order_id,lateMinutes:row.result_late_minutes===null?null:Number(row.result_late_minutes)}:null,
   check:state.check,canWithdraw:actor.actorId===row.designer_id&&['pending','returned'].includes(row.state)};
 }
 check(actor:TrustedActorContext,raw:unknown,changes:Record<string,OrderTimeRule>={},washing:OrderTimeWashingChanges=[],rewashing:OrderTimeWashingReworkChanges=[]){const operation=OrderTimeOperationSchema.parse(raw);return this.transaction(false,async db=>(await loadOrderTimeOperation(this.database,db,actor,operation,await this.time(db,operation),changes,washing,rewashing)).check);}
 read(actor:TrustedActorContext,id:string,changes:Record<string,OrderTimeRule>={},washing:OrderTimeWashingChanges=[],rewashing:OrderTimeWashingReworkChanges=[]){return this.transaction(false,async db=>this.result(db,actor,await this.visible(db,actor,id),changes,washing,rewashing));}
 arrange(actor:TrustedActorContext,raw:unknown,key:string){const input=OrderTimeArrangementSchema.parse(raw);return this.transaction(true,async db=>{
  await assertSlaSettingsActor(db,actor,true);const repo=new OrderTimeRequestRepository(db);
  return repo.receipt(actor.actorId,'arrange:'+input.resource.kind+':'+input.resource.id,key,input,async()=>{
   const operation:OrderTimeOperation={kind:'arrangement',resource:input.resource},time=await this.time(db,operation),state=await loadOrderTimeOperation(this.database,db,actor,operation,time,input.overrides,input.washing,input.rewashing);
   const subject=(await db.query(`SELECT effective FROM digital_order_time_subjects WHERE resource_kind=$1 AND ${input.resource.kind==='source'?'source_id':'production_order_id'}=$2`,[input.resource.kind,input.resource.id])).rows[0];
   if(subject&&!subject.effective)conflict('ORDER_TIME_REQUEST_REQUIRED','新订单尚未生效，请从设计师原申请接续办理');
   if(input.fingerprint!==state.check.fingerprint)conflict('ORDER_TIME_STALE','原单资料已更新，本次调整已保留，请重新核对后提交');
   if(state.check.feasibility==='unknown')conflict('ORDER_TIME_INPUT_REQUIRED',state.check.coverage.join('；')||'请补齐本单必要时间');
   if(state.check.feasibility==='insufficient'&&!input.acceptLate)conflict('ORDER_TIME_LATE_CONFIRMATION',orderTimeGapText(state.check));
   const eventId=randomUUID();await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'order_time_arranged','digital_production',$4,$5)`,[eventId,actor.requestId,actor.actorId,input.resource.id,JSON.stringify({plan:state.value.plan,lateMinutes:state.check.lateMinutes,acceptedLate:input.acceptLate})]);
   if(input.washing?.length){if(input.resource.kind!=='order')conflict('ORDER_TIME_INPUT_REQUIRED','请在正式订单采用洗水安排');for(const change of input.washing)await adoptBulkWashingWithClient(db,actor,input.resource.id,change.lineId,change.expectedVersion,change.document);}
   const previous=await new OrderTimePlanRepository(db).current(input.resource),saved=await new OrderTimePlanRepository(db).confirm({resource:input.resource,expectedRevision:previous?.revision??0,value:state.value,actorId:actor.actorId,eventRef:'audit_events:'+eventId,time,requestKey:'order-time-arrange:'+eventId},(resource,changes)=>refreshLinkedOrderTimeInput(this.database,db,actor,resource,time,changes));
   if(input.resource.kind==='order')await db.query('UPDATE digital_production_orders SET order_time_managed=true WHERE production_order_id=$1',[input.resource.id]);
   const current=await loadOrderTimeOperation(this.database,db,actor,operation,time);
   return {saved:true as const,planRevision:saved.revision,check:current.check};
  });
 });}
 submit(actor:TrustedActorContext,raw:unknown,key:string){const input=OrderTimeRequestSchema.parse(raw);return this.transaction(true,async db=>{
  const repo=new OrderTimeRequestRepository(db);
  return repo.receipt(actor.actorId,'request',key,input,async()=>{
   const time=await this.time(db,input.operation),state=await loadOrderTimeOperation(this.database,db,actor,input.operation,time);
   if(input.fingerprint!==state.check.fingerprint)conflict('ORDER_TIME_STALE','原单资料已更新，本次填写已保留，请重新核对');
   if(!state.designer&&!state.main)digitalForbidden();
   if(state.designer)await orderTimeRequester(db,actor,state.designerId);
   const row=await repo.create({operation:state.operation,check:state.check,actorId:actor.actorId,designerId:state.designerId,reason:input.reason,time,needsDesigner:!state.designer});
   await notifyOrderTime(db,row,time.now);return this.result(db,actor,await repo.read(row.request_id)??row);
  });
 });}
 resubmit(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  const input=OrderTimeRequestSchema.extend({expectedVersion:OrderTimeApplySchema.shape.expectedVersion}).parse(raw);
  return this.transaction(true,async db=>{
   const row=await this.visible(db,actor,id,true);await orderTimeRequester(db,actor,row.designer_id);
   return new OrderTimeRequestRepository(db).receipt(actor.actorId,'resubmit:'+id,key,input,async()=>{
    const scope=orderTimeOperationScope(input.operation),oldScope=orderTimeOperationScope(row.operation_json);
    if(scope?.kind!==oldScope?.kind||scope?.id!==oldScope?.id||input.operation.kind!==row.operation_json.kind)digitalForbidden();
    const time=await this.time(db,input.operation),state=await loadOrderTimeOperation(this.database,db,actor,input.operation,time);
    if(input.fingerprint!==state.check.fingerprint)conflict('ORDER_TIME_STALE','原单资料已更新，本次填写已保留，请重新核对');
    const saved=await new OrderTimeRequestRepository(db).resubmit(row,{expectedVersion:input.expectedVersion,actorId:actor.actorId,operation:state.operation,check:state.check,reason:input.reason,time});
    await notifyOrderTime(db,saved,time.now);return this.result(db,actor,await new OrderTimeRequestRepository(db).read(id)??saved);
   });
  });
 }
 apply(actor:TrustedActorContext,id:string,raw:unknown,key:string){const input=OrderTimeApplySchema.parse(raw);return this.transaction(true,async db=>{
  await assertSlaSettingsActor(db,actor,true);const row=await this.visible(db,actor,id,true),repo=new OrderTimeRequestRepository(db);
  return repo.receipt(actor.actorId,'apply:'+id,key,input,async()=>{
   if(row.version!==input.expectedVersion||row.state!=='pending')conflict('ORDER_TIME_STALE','申请已由其他人处理或更新，请刷新查看结果');
   const operation=await currentOrderTimeOperation(db,row.operation_json),time=await this.time(db,operation),state=await loadOrderTimeOperation(this.database,db,actor,operation,time,input.overrides,input.washing,input.rewashing);
   if(input.fingerprint!==state.check.fingerprint)conflict('ORDER_TIME_STALE','原单资料已更新，本次调整已保留，请重新核对后提交');
   if(state.check.feasibility==='unknown')conflict('ORDER_TIME_INPUT_REQUIRED',state.check.coverage.join('；')||'请先补齐本单适用流程及必要时间');
   if(state.check.feasibility==='insufficient'&&!input.acceptLate)conflict('ORDER_TIME_LATE_CONFIRMATION',orderTimeGapText(state.check));
   const eventId=randomUUID(),resource=orderTimeOperationScope(state.operation);
   await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
    VALUES($1,$2,$3,'order_time_activated','digital_production',$4,$5)`,[eventId,actor.requestId,actor.actorId,resource?.id??id,JSON.stringify({requestId:id,requestedBy:row.requested_by,designerId:row.designer_id,operation:state.operation,plan:state.value.plan,lateMinutes:state.check.lateMinutes,acceptedLate:input.acceptLate})]);
   await db.query('UPDATE digital_order_time_requests SET operation_json=$2 WHERE request_id=$1 AND version=$3',[id,JSON.stringify(operation),row.version]);
   const approvedFactoryWork=state.operation.kind==='confirm_order'&&Object.hasOwn(input.overrides,'factory_production_work')
    &&state.value.work.some(work=>work.parameterKey==='factory_production_work'&&!work.includedIn&&work.canonicalWorkRef?.startsWith('order:'));
   const outcome=await withinOrderTimeAdmission(db,{requestId:id,requestVersion:row.version,actorId:actor.actorId,designerId:row.designer_id,operation:state.operation,plan:state.value.plan,time,activationEventId:eventId,...(approvedFactoryWork?{approvedFactoryWork:true as const}:{})},async()=>{
    const native=state.operation.kind==='arrangement'?{sourceId:state.sourceId,orderId:state.orderId}:await this.execute(db,actor,state.operation,'order-time:'+id+':'+row.version);
    const target=native.orderId?{kind:'order' as const,id:native.orderId}:native.sourceId?{kind:'source' as const,id:native.sourceId}:resource;
    if(!target)throw Error('原业务办理没有返回本单身份');
    const sourceOperation=state.operation.kind==='development_publish'||state.operation.kind==='confirm_order'?state.operation:null;
    if(sourceOperation&&native.sourceId!==sourceOperation.sourceId)conflict('ORDER_TIME_CONFLICT','原业务返回的开发来源与原申请不一致');
    if(state.operation.kind==='confirm_order'&&!native.orderId)conflict('ORDER_TIME_CONFLICT','正式确认没有返回原订单身份');
    if(native.sourceId&&native.orderId){
     const linked=(await db.query('SELECT source_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[native.orderId])).rows[0];
     if(linked?.source_id!==native.sourceId||sourceOperation&&sourceOperation.sourceId!==native.sourceId)conflict('ORDER_TIME_CONFLICT','原业务返回的开发来源与正式订单不一致');
     if(sourceOperation){
      // Publication may create an order while its original READY tasks still
      // belong to the source. Adopt that exact source first on this client so
      // order plan confirmation inherits its frozen policy and original targets.
      // An already adopted source keeps its existing version and history.
      const source={kind:'source' as const,id:native.sourceId},plans=new OrderTimePlanRepository(db);
      if(!await plans.current(source)){
       const actual=await loadOrderTimeOperation(this.database,db,actor,{kind:'arrangement',resource:source},time,input.overrides);
       await plans.confirm({resource:source,expectedRevision:0,value:actual.value,actorId:actor.actorId,eventRef:'audit_events:'+eventId,time,requestKey:'order-time-request:'+id+':'+row.version+':source'});
      }
      await db.query("UPDATE digital_order_time_subjects SET effective=true WHERE resource_kind='source' AND source_id=$1",[source.id]);
     }
    }
    // Re-read actual native task/step/PO identities after publication on this
    // same client; temporary preview IDs never become real execution events.
    if(input.washing?.length){if(target.kind!=='order')conflict('ORDER_TIME_INPUT_REQUIRED','请在正式订单采用洗水安排');for(const change of input.washing)await adoptBulkWashingWithClient(db,actor,target.id,change.lineId,change.expectedVersion,change.document);}
    const actualOperation:OrderTimeOperation={kind:'arrangement',resource:target};
    const actual=state.operation.kind==='arrangement'&&!input.washing?.length?state:await loadOrderTimeOperation(this.database,db,actor,actualOperation,time,input.overrides);
    const previous=await new OrderTimePlanRepository(db).current(target);
    const saved=await new OrderTimePlanRepository(db).confirm({resource:target,expectedRevision:previous?.revision??0,value:actual.value,actorId:actor.actorId,eventRef:'audit_events:'+eventId,time,requestKey:'order-time-request:'+id+':'+row.version},(resource,changes)=>refreshLinkedOrderTimeInput(this.database,db,actor,resource,time,changes));
    if(target.kind==='order')await new DigitalProductionTaskService(this.database).refreshShipSampleTimingWithClient(db,actor,target.id);
    await db.query(`UPDATE digital_order_time_subjects SET effective=true WHERE resource_kind=$1 AND ${target.kind==='source'?'source_id':'production_order_id'}=$2`,[target.kind,target.id]);
    return {native,saved};
   });
   const finished=await repo.finish(row,{expectedVersion:input.expectedVersion,actorId:actor.actorId,planId:outcome.saved.id,orderId:outcome.native.orderId,lateMinutes:state.check.lateMinutes,time});
   await notifyOrderTime(db,finished,time.now);return this.result(db,actor,await repo.read(id)??finished);
  });
 });}
 close(actor:TrustedActorContext,id:string,raw:unknown,key:string,state:'returned'|'withdrawn'){
  const input=state==='returned'?OrderTimeReturnSchema.parse(raw):OrderTimeWithdrawSchema.parse(raw);
  return this.transaction(true,async db=>{
   const row=await this.visible(db,actor,id,true);if(state==='returned')await assertSlaSettingsActor(db,actor,true);else await orderTimeRequester(db,actor,row.designer_id);
   return new OrderTimeRequestRepository(db).receipt(actor.actorId,state+':'+id,key,input,async()=>{
    const time=await this.time(db,row.operation_json),saved=await new OrderTimeRequestRepository(db).close(row,{expectedVersion:input.expectedVersion,actorId:actor.actorId,state,...('reason'in input&&typeof input.reason==='string'?{reason:input.reason}:{}),time});
    await notifyOrderTime(db,saved,time.now);return this.result(db,actor,await new OrderTimeRequestRepository(db).read(id)??saved);
   });
  });
 }
}

/** Reuse the existing site-only event/receipt lifecycle. Closing a request
 * changes its one state, so all other managers' derived tasks disappear. */
async function notifyOrderTime(db:PoolClient,row:OrderTimeRequestRow,now:string){
 const recipients=row.state==='pending'?(await db.query(`SELECT DISTINCT u.id FROM app_users u JOIN user_role_assignments r ON r.user_id=u.id AND r.revoked_at IS NULL
  WHERE u.enabled AND r.role_code IN ('owner_group','production_management','root_superuser') AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)`)).rows.map(user=>user.id as string):[row.designer_id];
 const key=`order-time-request:${row.request_id}:${row.version}:${row.state}`,eventId=randomUUID();
 await db.query(`INSERT INTO digital_production_notification_events(event_id,source_key,todo_id,event_kind,created_at) VALUES($1,$2,$3,'order_time_request',$4) ON CONFLICT(source_key) DO NOTHING`,[eventId,key,row.request_id,now]);
 const event=(await db.query('SELECT event_id FROM digital_production_notification_events WHERE source_key=$1',[key])).rows[0]!;
 for(const recipient of new Set(recipients))await db.query('INSERT INTO digital_production_notification_receipts(event_id,recipient_id,source_event_id) VALUES($1,$2,$1) ON CONFLICT DO NOTHING',[event.event_id,recipient]);
}
