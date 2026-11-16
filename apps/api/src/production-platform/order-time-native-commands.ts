import type {Pool,PoolClient} from 'pg';
import type {PatternRoomOrderService} from '../pattern-room/order-service.js';
import type {SourcingService} from '../sourcing/sourcing-service.js';
import {DigitalOrderCreateSchema,initialCustomerOrderInput,beijingCalendarDate,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import {publicationFormalInput} from './order-time-publication-intent.js';
import {orderTimeAdmission} from './order-time-admission.js';
import {DigitalProductionIdentityService} from './identity-service.js';
import {DigitalDevelopmentService} from './development-service.js';
import {ProductionInstructionService} from './production-instruction-service.js';
import {DevelopmentRoundService} from './development-round-service.js';
import {ProductionReadinessService} from './production-readiness-service.js';
import type {OrderTimeNativeExecutor} from './order-time-request-service.js';
import type {OrderTimeOperation} from '@dx-rework/contracts/order-time-requests';

/** Resolve only native version fields. Files and the candidate remain in the
 * original saved business records; no copied or substituted user identity. */
export async function currentOrderTimeOperation(db:PoolClient,operation:OrderTimeOperation):Promise<OrderTimeOperation>{
 switch(operation.kind){
  case 'development_publish':{
   const row=(await db.query('SELECT version FROM digital_development_documents WHERE source_id=$1',[operation.sourceId])).rows[0];
   return row?{...operation,input:{...operation.input,expectedVersion:row.version}}:operation;
  }
  case 'instruction_publish':{
   const row=(await db.query('SELECT d.version,o.version AS order_version FROM digital_instruction_documents d JOIN digital_production_orders o USING(production_order_id) WHERE production_order_id=$1',[operation.orderId])).rows[0];
   return row?{...operation,input:{...operation.input,expectedVersion:row.version,orderVersion:row.order_version}}:operation;
  }
  case 'development_revision':{
   const row=(await db.query('SELECT version,based_on_round FROM digital_development_round_drafts WHERE source_id=$1',[operation.sourceId])).rows[0];
   return row?{...operation,input:{expectedDraftVersion:row.version,basedOnRound:row.based_on_round}}:operation;
  }
  case 'confirm_order':{
   const row=(await db.query('SELECT document FROM digital_development_documents WHERE source_id=$1',[operation.sourceId])).rows[0],draft=row?.document?.customerOrderDraft;
   if(draft?.withOrder&&draft.stage!=='preorder'){
    const current=DigitalOrderCreateSchema.safeParse(initialCustomerOrderInput(draft.order));
    if(current.success)return {...operation,input:{...current.data,...(row.document.productionPlanning?{productionPlanning:row.document.productionPlanning}:{})}};
   }
   return operation;
  }
  default:return operation;
 }
}
export function orderTimeNativeExecutor(database:Pool,creationEnabled:boolean,patternOrders?:PatternRoomOrderService,sourcing?:SourcingService):OrderTimeNativeExecutor{
 return async(db,actor,operation,key)=>{
  const identity=new DigitalProductionIdentityService(database,creationEnabled,sourcing).inTransaction(db);
  switch(operation.kind){
   case 'development_publish':{
    const sheet=await new DigitalDevelopmentService(database,creationEnabled,patternOrders).inTransaction(db).publish(actor,operation.sourceId,operation.input.expectedVersion,key,operation.input.patternOrder);
    const admission=orderTimeAdmission(db),time=admission?new Date(admission.time.now):null;
    const calendar=time?{serverToday:beijingCalendarDate(time),minimumInitialCustomerDate:minimumInitialCustomerDate(time),orderTimeEnabled:true}:await identity.orderCalendar(actor,operation.sourceId);
    const input=publicationFormalInput(sheet.document,calendar,Boolean(admission?.plan.company.framework));
    if(input){
     const order=await identity.createOrder(actor,input,key+':formal',operation.sourceId);return {sourceId:operation.sourceId,orderId:order.productionOrderId};
    }
    return {sourceId:operation.sourceId,orderId:null};
   }
   case 'confirm_order':{const order=await identity.createOrder(actor,operation.input,key,operation.sourceId);return {sourceId:operation.sourceId,orderId:order.productionOrderId};}
   case 'direct_order':{const order=await identity.createOrder(actor,{...operation.input,productionPlanning:operation.route},key);return {sourceId:order.sourceId,orderId:order.productionOrderId};}
   case 'instruction_publish':{
    const readiness=await new ProductionReadinessService(database).read(actor,{kind:'order',id:operation.orderId},db);
    const sheet=await new ProductionInstructionService(database,creationEnabled).inTransaction(db).publish(actor,operation.orderId,{...operation.input,expectedReadinessRevision:readiness.revision},key);
    return {sourceId:sheet.order.sourceId,orderId:operation.orderId};
   }
   case 'development_revision':{const result=await new DevelopmentRoundService(database,creationEnabled,patternOrders).inTransaction(db).publish(actor,operation.sourceId,operation.input,key);return {sourceId:result.sourceId,orderId:null};}
   case 'arrangement':return {sourceId:operation.resource.kind==='source'?operation.resource.id:null,orderId:operation.resource.kind==='order'?operation.resource.id:null};
  }
 };
}
