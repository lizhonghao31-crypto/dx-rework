import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {OrderTimeOperation} from '@dx-rework/contracts/order-time-requests';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {ContextBusinessClock,observedBusinessTime,businessNow} from '../acceptance-clock/business-time.js';
import {acceptsNewOrderTime,orderTimeAdmission,withinOrderTimeAdmission} from './order-time-admission.js';
import {loadOrderTimeOperation,orderTimeOperationScope} from './order-time-operation-state.js';
import {refreshLinkedOrderTimeInput} from './order-time-linked-applicability.js';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
import {DigitalProductionTaskService} from './task-service.js';

/** Called inside the original lifecycle/row/idempotency command. A request's
 * authorized application already owns its selected policy and outer commit. */
export async function automaticOrderTime<T>(database:Pool,db:PoolClient,actor:TrustedActorContext,operation:OrderTimeOperation,work:()=>Promise<T>,created?:(result:T)=>{kind:'source'|'order';id:string}):Promise<T>{
 if(orderTimeAdmission(db))return work();
 const resource=orderTimeOperationScope(operation),existing=resource?await new OrderTimePlanRepository(db).current(resource):null;
 if(!existing&&!await acceptsNewOrderTime(db))return work();
 const time=resource?await new ContextBusinessClock(database,db).read(resource):observedBusinessTime(businessNow);
 const state=await loadOrderTimeOperation(database,db,actor,operation,time);
 if(state.check.feasibility==='unknown')throw new ApplicationError('ORDER_TIME_INPUT_REQUIRED',state.check.coverage.join('；')||'请先补齐本单适用流程及必要时间',409);
 if(state.check.feasibility==='insufficient')throw new ApplicationError('ORDER_TIME_REQUEST_REQUIRED','按本单实际流程计算，现有时间不足，请提交本单时效申请',409);
 const eventId=randomUUID();
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'order_time_activated','digital_production',$4,$5)`,[eventId,actor.requestId,actor.actorId,resource?.id??eventId,JSON.stringify({automatic:true,designerId:state.designerId,plan:state.value.plan,lateMinutes:state.check.lateMinutes})]);
 return withinOrderTimeAdmission(db,{requestId:null,requestVersion:null,actorId:actor.actorId,designerId:state.designerId,operation,plan:state.value.plan,time,activationEventId:eventId},async()=>{
  const result=await work(),target=created?.(result)??resource;if(!target)throw Error('原生生效缺少本单身份');
  const actual=await loadOrderTimeOperation(database,db,actor,{kind:'arrangement',resource:target},time);
  const prior=await new OrderTimePlanRepository(db).current(target);
  await new OrderTimePlanRepository(db).confirm({resource:target,expectedRevision:prior?.revision??0,value:actual.value,actorId:actor.actorId,eventRef:'audit_events:'+eventId,time,requestKey:'order-time-native:'+eventId},(resource,changes)=>refreshLinkedOrderTimeInput(database,db,actor,resource,time,changes));
  if(target.kind==='order')await new DigitalProductionTaskService(database).refreshShipSampleTimingWithClient(db,actor,target.id);
  await db.query(`UPDATE digital_order_time_subjects SET effective=true WHERE resource_kind=$1 AND ${target.kind==='source'?'source_id':'production_order_id'}=$2`,[target.kind,target.id]);
  return result;
 });
}
