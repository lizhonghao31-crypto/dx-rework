import type {PatternRoomOrderService} from "../pattern-room/order-service.js";
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {DigitalDevelopmentService} from './development-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DigitalProductionAccessPolicy,digitalNotFound} from './access-policy.js';
import {DIGITAL_TASK_ROLES,type DigitalTaskKind} from './task-access-repository.js';
import {developmentRoute,missingSewingMaterials} from './development-route.js';
const fail=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_ROUTE_CONFLICT',message,409);};
export type DevelopmentRouteAction={craftExecution:'内部'|'外发'|null;taskId:string;note:string;result:'通过'|'退回';nextAssigneeId:string|null;sentDate:string|null;trackingNo:string|null};
export class DevelopmentRouteService {
 constructor(private readonly database:Pool,private readonly patternOrders?:PatternRoomOrderService){}
 private async task(db:PoolClient,sourceId:string,taskId:string){return (await db.query('SELECT t.*,a.task_kind,a.assignee_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2',[sourceId,taskId])).rows[0]??digitalNotFound();}
 private async recipient(db:PoolClient,sourceId:string,kind:DigitalTaskKind,explicit:string|null){
   const role=DIGITAL_TASK_ROLES[kind],policy=new DigitalProductionAccessPolicy(db);
   if(explicit){if(!await policy.activeRole(explicit,role))fail('下一办理人不具备该节点的有效岗位');return explicit;}
   if(role==='sample_designer'){
     const id=(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0].created_by;
     return await policy.activeRole(id,role)?id:null;
   }
   if(kind==='development_sewing'){
     const id=(await db.query('SELECT sewing_worker_id FROM digital_development_dispatch WHERE source_id=$1',[sourceId])).rows[0]?.sewing_worker_id;
     return id&&await policy.activeRole(id,role)?id:null;
   }
   const people=(await db.query('SELECT DISTINCT user_id FROM user_role_assignments WHERE role_code=$1 AND revoked_at IS NULL',[role])).rows;
   const active=[];for(const person of people)if(await policy.activeRole(person.user_id,role))active.push(person.user_id);
   return active.length===1?active[0]:null;
 }
 async advance(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string,nextAssigneeId:string|null=null){
   const task=await this.task(db,sourceId,taskId);
   const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db);
   const route=developmentRoute(sheet.document!),index=route.indexOf(task.task_kind);
   if(index<0||index===route.length-1)return null;
   const kind=route[index+1]!;
   const service=new DigitalProductionTaskService(this.database);
   const next=await service.createWithClient(db,actor,{resource:{kind:'source',id:sourceId},authorizingTaskId:taskId,kind,routeId:task.route_instance_id,routeVersion:task.route_version,occurrence:task.route_version,assigneeId:await this.recipient(db,sourceId,kind,nextAssigneeId),predecessors:[taskId]});
   const now=new Date().toISOString();
   if(kind==='development_sewing'){
     await service.setConditionWithClient(db,actor,next.taskId,'handover_received',true,now,sheet.document!.craft==='无'?'裁板完成交车板':'文员转交车板');
     if(!missingSewingMaterials(sheet.document!,sheet.materialEvents).length)await service.setConditionWithClient(db,actor,next.taskId,'materials_ready',true,now,'本轮物料齐备');
   }
   if(kind==='development_washing')await service.setConditionWithClient(db,actor,next.taskId,'handover_received',true,now,'文员登记实际送洗');
   if(kind==='development_tail_check')await service.setConditionWithClient(db,actor,next.taskId,'washing_finished',true,now,sheet.document!.washing==='免洗'?'本轮免洗':'洗水完成后交尾查');
   return next;
 }
 async releaseSewing(db:PoolClient,actor:TrustedActorContext,sourceId:string){
   const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db);
   if(missingSewingMaterials(sheet.document!,sheet.materialEvents).length)return;
   const tasks=(await db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_sewing' AND t.state='pending'",[sourceId])).rows;
   for(const task of tasks)await new DigitalProductionTaskService(this.database).setConditionWithClient(db,actor,task.task_id,'materials_ready',true,new Date().toISOString(),'设计师确认本轮物料齐备');
 }
 async complete(db:PoolClient,actor:TrustedActorContext,sourceId:string,input:DevelopmentRouteAction,key:string){
   await new DigitalProductionAccessPolicy(db).assert(actor,'task',input.taskId,'execute');
   const task=await this.task(db,sourceId,input.taskId);
   const kinds:Partial<Record<DigitalTaskKind,string>>={development_craft_dispatch:'发工艺',development_printing:'工艺完成',development_embroidery:'工艺完成',development_print_embroidery:'工艺完成',development_craft_confirmation:'工艺确认',development_sewing_transfer:'转交车板',development_sewing:'车板完成',development_washing:'洗水完成',development_tail_check:input.result==='退回'?'尾查退回':'尾查通过',development_confirmation:'最终设计确认',development_shipping:'寄出'};
   const kind=kinds[task.task_kind as DigitalTaskKind];if(!kind||task.state!=='ready')fail('当前节点尚不可办理');
   if(input.result==='退回'&&task.task_kind!=='development_tail_check')fail('实际修改请使用复版入口，不能直接覆盖本轮');
   if(input.result==='退回'&&!input.note.trim())fail('请填写内部尾查问题');
   if(input.nextAssigneeId&&task.task_kind!=='development_craft_dispatch')fail('本操作不能改派下一节点，请使用任务改派');
   if(task.task_kind==='development_craft_dispatch'&&!input.craftExecution)fail('请记录工艺内部制作或外发');
   if(task.task_kind==='development_craft_dispatch'&&!input.nextAssigneeId)fail('请选择工艺办理人');
   if(task.task_kind==='development_shipping'&&(!input.sentDate||!input.trackingNo?.trim()))fail('请填写实际寄出日期和快递号');
   if(task.task_kind==='development_shipping'&&input.sentDate&&input.sentDate>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}))fail('实际寄出日期不能晚于今天');
   if(task.task_kind==='development_sewing'){
     const sheet=await new DigitalDevelopmentService(this.database,true).read(actor,sourceId,db);
     if(missingSewingMaterials(sheet.document!,sheet.materialEvents).length)fail('本轮所需物料尚未齐备');
   }
   await db.query('INSERT INTO digital_development_route_facts(fact_id,source_id,task_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[randomUUID(),sourceId,input.taskId,task.route_version,kind,JSON.stringify(input),actor.actorId]);
   if(task.task_kind==='development_sewing'||task.task_kind==='development_confirmation'){
     const native=(await db.query("SELECT o.order_id,o.current_round_id,o.version,o.status FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) WHERE l.source_id=$1 AND o.deleted_at IS NULL FOR UPDATE OF o",[sourceId])).rows[0];
     if(!native||!this.patternOrders)fail('请先由设计师提交原打板执行单，并由技术主管确认派工');
     const original=this.patternOrders!.inTransaction(db);
     if(task.task_kind==='development_shipping'&&input.sentDate&&input.sentDate>new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'}))fail('实际寄出日期不能晚于今天');
   if(task.task_kind==='development_sewing'){
       if(native.status==='in_progress')await original.completeDevelopment(actor,sourceId,input.taskId,native.order_id,{roundId:native.current_round_id,version:native.version});
       else if(native.status!=='pending_confirmation')fail('原打板执行状态不允许报车板完成');
     }else{
       if(native.status==='pending_confirmation')await original.handoff(actor,native.order_id,{roundId:native.current_round_id,version:native.version},`development-final:${key}`);
       else if(native.status!=='completed')fail('请先完成原打板执行再最终确认');
     }
   }
   const service=new DigitalProductionTaskService(this.database),now=new Date().toISOString();
   await service.setConditionWithClient(db,actor,input.taskId,'business_recorded',true,now,input.note);
   await service.completeWithClient(db,actor,input.taskId,{note:input.note},`route:${key}`);
   if(input.result!=='退回')await this.advance(db,actor,sourceId,input.taskId,input.nextAssigneeId);
   return {taskId:input.taskId,result:input.result};
 }
}
