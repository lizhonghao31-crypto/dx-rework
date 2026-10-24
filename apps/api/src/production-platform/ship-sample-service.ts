import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {shipSampleFacts} from './ship-sample-facts.js';
import type {FactoryFollowup} from '@dx-rework/contracts/factory-flow';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {DigitalProductionTaskService} from './task-service.js';
const fail=(message:string):never=>{throw new ApplicationError('SHIP_SAMPLE_CONFLICT',message,409);};
export class ShipSampleService{
 constructor(private readonly database:Pool){}
 async ensureWithClient(db:PoolClient,actor:TrustedActorContext,orderId:string){
  if((await db.query("SELECT 1 FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind='bulk_ship_sample'",[orderId])).rowCount)return;
  const order=(await db.query('SELECT primary_merchandiser_id FROM digital_production_orders WHERE production_order_id=$1',[orderId])).rows[0];
  await new DigitalProductionTaskService(this.database).createWithClient(db,actor,{resource:{kind:'order',id:orderId},kind:'bulk_ship_sample',routeId:orderId,routeVersion:1,occurrence:1,assigneeId:order.primary_merchandiser_id,occurredAt:null});
 }
 async record(actor:TrustedActorContext,orderId:string,input:FactoryFollowup,key:string){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail('缺少有效操作标识');
  if(!input.occurredAt||!Number.isFinite(Date.parse(input.occurredAt))||!input.trackingNumber.trim()||Date.parse(input.occurredAt)>Date.now())fail('请填写真实寄出时间和快递单号，时间不能在未来');
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const policy=new DigitalProductionAccessPolicy(db);await policy.assert(actor,'order',orderId,'technical');
   const order=(await db.query('SELECT * FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[orderId])).rows[0];
   if(!isRootActor(actor)&&(order.primary_merchandiser_id!==actor.actorId||!await policy.lockActiveRole(actor.actorId,'order_merchandiser')))digitalForbidden();
   if((await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE (resource_kind='order' AND resource_id=$1 OR resource_kind='source' AND resource_id=$2) AND state<>'active'",[orderId,order.source_id])).rowCount)fail('订单或开发来源已暂停或取消');
   if((await db.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[orderId])).rowCount)fail('本单已结案，保留原寄样记录');
   const command=`ship-sample:${orderId}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT * FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==hash)fail('操作标识已用于不同内容');await db.query('COMMIT');return;}
   const po=(await db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows.map(r=>r.line_id as string),lineIds=input.lineIds??po;
   if(!lineIds.length||new Set(lineIds).size!==lineIds.length||lineIds.some(id=>!po.includes(id)))fail('寄样范围必须属于本订单当前PO');
   const priorRecords=await shipSampleFacts(db,orderId);
   if(lineIds.some(id=>priorRecords.some(r=>r.lineIds.includes(id))))fail('所选PO已有寄出记录，请核对原记录');
   const eventId=randomUUID();await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
    VALUES($1,'order',$2,'ship_sample_sent',$3,$4,'补报未核实',$5)`,[eventId,orderId,actor.actorId,input.occurredAt,JSON.stringify({lineIds,trackingNumber:input.trackingNumber,note:input.note})]);
   await this.ensureWithClient(db,actor,orderId);
   await new DigitalProductionTaskService(this.database).refreshShipSampleTimingWithClient(db,actor,orderId);
   if(po.every(id=>lineIds.includes(id)||priorRecords.some(r=>r.lineIds.includes(id)))){
    const completedAt=priorRecords.some(r=>r.occurredAt===null)?null:new Date(Math.max(Date.parse(input.occurredAt!),...priorRecords.map(r=>Date.parse(r.occurredAt!)))).toISOString();
    const task=(await db.query("SELECT a.task_id,t.state FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='bulk_ship_sample'",[orderId])).rows[0];
    if(task&&!['completed','cancelled'].includes(task.state)){const tasks=new DigitalProductionTaskService(this.database);await tasks.setConditionWithClient(db,actor,task.task_id,'business_recorded',true,completedAt,'对应订单PO船样已寄出，快递单号已记录');await tasks.completeWithClient(db,actor,task.task_id,{note:input.note,occurredAt:completedAt},`ship-sample:${eventId}`);}
   }
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify({eventId})]);await db.query('COMMIT');
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
}
