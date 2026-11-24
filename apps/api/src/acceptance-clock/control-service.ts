import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
import {DigitalProductionNotificationService} from '../production-platform/notification-service.js';
import {SlaOrderService} from '../production-platform/sla-order-service.js';
import {TodoTimingService} from '../todos/timing-service.js';
import {DigitalProductionAccessPolicy} from '../production-platform/access-policy.js';
import {clockConflict,clockHash} from './repository.js';
import {clockMaterialInvestmentRoots,clockRoots,clockUuid} from './scope.js';
import type {AcceptanceClockRuntime} from './runtime.js';

type Boundary='warning_before'|'warning'|'due_before'|'due'|'due_after';
type Target={id:string;label:string;dueAt:string;warningAt:string|null;exclusive:boolean};
/** Control commands are separate from business commands: time never completes work. */
export class AcceptanceClockControlService{
 constructor(readonly runtime:AcceptanceClockRuntime){}
 async targets(id:string,actor:TrustedActorContext):Promise<Target[]>{
  return this.runtime.run(id,actor,async()=>{
   const db=this.runtime.database;
   const tasks=(await db.query(`SELECT t.task_id,p.label,d.due_at,d.warning_at,coalesce((d.sla_basis->>'exclusive')::boolean,false) AS exclusive
    FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    JOIN acceptance_sla_clock_resources m ON m.resource_kind=CASE WHEN a.production_order_id IS NULL THEN 'source' ELSE 'order' END
     AND m.resource_id=coalesce(a.production_order_id,a.source_id) AND m.scenario_id=$1
    JOIN LATERAL(SELECT * FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)d ON true
    JOIN digital_production_deadline_policies p ON p.node_key=d.policy_node_key AND p.version=d.policy_version
    WHERE t.state IN ('pending','ready','blocked') AND d.due_at IS NOT NULL`,[id])).rows;
   const policy=new DigitalProductionAccessPolicy(db),visible=[];
   for(const task of tasks)if(await policy.allowed(actor,'task',task.task_id,'technical'))visible.push(task);
   const result:Target[]=visible.map(t=>({id:t.task_id,label:t.label,dueAt:t.due_at.toISOString(),warningAt:t.warning_at?.toISOString()??null,exclusive:t.exclusive}));
   const roots=(await this.runtime.repository.view(id)).orderIds;
   for(const orderId of roots){
    const read=await new SlaOrderService(db).read(actor,orderId);
    if(read.status!=='planned')continue;
    for(const node of read.nodes){
     if(!node.deadline.at||node.status==='not_applicable'||node.status.startsWith('completed'))continue;
     const plan=read.current.plan.nodes.find(n=>n.id===node.id)!;
     const start=node.actualStart??node.start.at,due=Date.parse(node.deadline.at);
     const warning=['duration','included'].includes(plan.kind)&&start&&due>=Date.parse(start)?new Date(Date.parse(start)+(due-Date.parse(start))*(read.facts[node.id]?.standardWarningPercent??read.current.plan.warningPercent)/100).toISOString():null;
     result.push({id:`${orderId}:${node.id}`,label:plan.label,dueAt:node.deadline.at,warningAt:warning,exclusive:node.deadline.exclusive});
    }
   }
   return result;
  });
 }
 private async fingerprint(id:string){
  // Includes persisted business versions, not just the time version. Audit timestamps stay real.
  const row=await this.runtime.repository.row(id);
  const evidence=(await this.runtime.database.query(`WITH roots AS (
    SELECT resource_id FROM acceptance_sla_clock_resources WHERE scenario_id=$1
   ),ids AS (
    SELECT resource_id::text AS id FROM roots
    UNION SELECT child_id::text FROM digital_production_child_links WHERE production_order_id IN(SELECT resource_id FROM roots)
    UNION SELECT order_id::text FROM digital_development_pattern_links WHERE source_id IN(SELECT resource_id FROM roots)
    UNION SELECT r.receiving_batch_id::text FROM receiving_receipts r JOIN digital_production_child_links l ON l.module='receiving' AND l.child_id=r.receipt_id WHERE l.production_order_id IN(SELECT resource_id FROM roots)
    UNION SELECT t.work_task_id::text FROM rework_work_tasks t JOIN digital_production_child_links l ON l.module='rework' AND l.child_id=t.rework_order_id WHERE l.production_order_id IN(SELECT resource_id FROM roots)
    UNION SELECT task_id::text FROM digital_production_task_access WHERE source_id IN(SELECT resource_id FROM roots) OR production_order_id IN(SELECT resource_id FROM roots)
   ) SELECT
    (SELECT jsonb_agg(jsonb_build_array(event_id,action) ORDER BY event_id) FROM operation_events WHERE entity_id IN(SELECT id FROM ids)) AS native,
    (SELECT jsonb_agg(jsonb_build_array(id,action) ORDER BY id) FROM audit_events WHERE entity_id IN(SELECT id FROM ids)) AS audit,
    (SELECT jsonb_agg(jsonb_build_array(e.event_id,e.corrects_event_id) ORDER BY e.event_id) FROM digital_production_task_events e WHERE e.resource_id IN(SELECT resource_id FROM roots)) AS facts,
    (SELECT jsonb_agg(jsonb_build_array(p.plan_id,p.revision,p.snapshot_id) ORDER BY p.plan_id) FROM digital_sla_plans p WHERE p.production_order_id IN(SELECT resource_id FROM roots)) AS plans`,[id])).rows[0];
  return clockHash({version:row.version,businessRevision:row.business_revision,configurationId:row.configuration_id,evidence});
 }
 async preview(id:string,actor:TrustedActorContext,input:{nodeId:string;boundary:Boundary}){
  return this.runtime.run(id,actor,async()=>{
   const target=(await this.targets(id,actor)).find(t=>t.id===input.nodeId);if(!target)return clockConflict('该节点没有可跳转的有效时限，请先办理原业务或补齐原日期');
   const base=input.boundary.startsWith('warning')?target.warningAt:target.dueAt;
   if(!base)return clockConflict('该节点没有临期时间依据');
   const at=new Date(Date.parse(base)+(input.boundary.endsWith('_before')?-1:input.boundary==='due_after'?1:0)).toISOString();
   const row=await this.runtime.repository.row(id);if(Date.parse(at)<=row.business_now.getTime())clockConflict('该边界已到达；重测请复制为新场景');
   const body=Buffer.from(JSON.stringify({id,actorId:actor.actorId,at,fingerprint:await this.fingerprint(id),expiresAt:Date.now()+5*60000})).toString('base64url');
   const token=`${body}.${createHmac('sha256',this.runtime.secret).update(body).digest('base64url')}`;
   return {at,label:target.label,boundary:input.boundary,exclusive:target.exclusive,token,version:row.version};
  });
 }
 private async verifyPreview(id:string,actor:TrustedActorContext,at:string,token:string){
  const [body,signature,...extra]=token.split('.');
  const expected=body?createHmac('sha256',this.runtime.secret).update(body).digest('base64url'):'';
  if(extra.length||!signature||signature.length!==expected.length||!timingSafeEqual(Buffer.from(signature),Buffer.from(expected)))clockConflict('时间预览无效，请重新预览');
  let value:{id:string;actorId:string;at:string;fingerprint:string;expiresAt:number};
  try{value=JSON.parse(Buffer.from(body!,'base64url').toString());}catch{clockConflict('时间预览无效');}
  if(value!.id!==id||value!.actorId!==actor.actorId||value!.at!==at||!Number.isFinite(value!.expiresAt)||value!.expiresAt<Date.now()||value!.fingerprint!==await this.fingerprint(id))clockConflict('时间、标准或业务事实已变化，请重新预览');
 }
 async advance(id:string,actor:TrustedActorContext,input:{expectedVersion:number;requestKey:string;at:string;previewToken?:string|undefined}){
  return this.runtime.run(id,actor,async()=>{
   const effect=await this.runtime.repository.change(id,actor.actorId,input,input.previewToken?async()=>this.verifyPreview(id,actor,input.at,input.previewToken!):undefined);
   if(effect.replayed&&(await this.runtime.repository.row(id)).version!==effect.effect.version){
    // A retry of an old command must not scan an old instant or advance again.
    // Recover a crash between persisted advance and scan as a failed historical scan.
    await this.runtime.database.query(`INSERT INTO acceptance_sla_clock_scans(scan_id,scenario_id,request_key,clock_version,business_time,actor_id,status,error_message,finished_at)
      VALUES($1,$2,$3,$4,$5,$6,'failed','原时点扫描未完成且时间已推进，请扫描当前时刻',CURRENT_TIMESTAMP) ON CONFLICT DO NOTHING`,[randomUUID(),id,input.requestKey,effect.effect.version,effect.effect.now,actor.actorId]);
    const saved=(await this.runtime.database.query('SELECT status,result_json,error_message FROM acceptance_sla_clock_scans WHERE scenario_id=$1 AND request_key=$2',[id,input.requestKey])).rows[0];
    return {effect,scan:{status:saved.status,result:saved.result_json,message:saved.error_message},scene:await this.runtime.repository.view(id)};
   }
   const scan=await this.runtime.withObservation(id,()=>this.scanLocked(id,actor,input.requestKey));
   return {effect,scan,scene:await this.runtime.repository.view(id)};
  });
 }
 async standard(id:string,actor:TrustedActorContext,input:{expectedVersion:number;requestKey:string;configurationId:string}){
  if(!actor.actorRoles.some(r=>['owner_group','production_management'].includes(r))&&!isRootActor(actor))throw new ApplicationError('FORBIDDEN','只有供应链总监、老板或Root可调整测试标准',403);
  return this.runtime.run(id,actor,async()=>{
   const effect=await this.runtime.repository.change(id,actor.actorId,input);
   return {effect,scene:await this.runtime.repository.view(id)};
  });
 }
 async scan(id:string,actor:TrustedActorContext,key:string){return this.runtime.run(id,actor,()=>this.scanLocked(id,actor,key));}
 private async scanLocked(id:string,actor:TrustedActorContext,key:string){
  const db=this.runtime.database,row=await this.runtime.repository.row(id);
  const previous=(await db.query('SELECT * FROM acceptance_sla_clock_scans WHERE scenario_id=$1 AND request_key=$2',[id,key])).rows[0];
  if(previous){if(previous.clock_version!==row.version||previous.actor_id!==actor.actorId)clockConflict('扫描标识已用于其他时间或操作者');return {status:previous.status,result:previous.result_json,message:previous.error_message};}
  // The scene lock proves no earlier scan is running. Persist an interrupted process honestly.
  await db.query("UPDATE acceptance_sla_clock_scans SET status='failed',error_message='上次扫描中断，可重新扫描',finished_at=CURRENT_TIMESTAMP WHERE scenario_id=$1 AND status='pending'",[id]);
  const scanId=randomUUID();
  await db.query("INSERT INTO acceptance_sla_clock_scans(scan_id,scenario_id,request_key,clock_version,business_time,actor_id,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",[scanId,id,key,row.version,row.business_now,actor.actorId]);
  try{
   await new DigitalProductionNotificationService(db).runOnce();
   const timing=await new TodoTimingService(db).runOnce(actor);
   const rows=(await db.query(`SELECT e.event_id,e.task_id,e.todo_id,e.development_source_id,e.event_kind,r.recipient_id
    FROM digital_production_notification_events e JOIN digital_production_notification_receipts r USING(event_id)`)).rows;
   let count=0;
   for(const event of rows){
    let nativeId=event.task_id??event.development_source_id;
    if(event.event_kind!=='material_investment'&&!nativeId&&event.todo_id){const todo=(await db.query('SELECT route_descriptor FROM rework_todos WHERE todo_id=$1',[event.todo_id])).rows[0];nativeId=todo?.route_descriptor?.reworkOrderId??todo?.route_descriptor?.entityId;}
    const roots=event.event_kind==='material_investment'?await clockMaterialInvestmentRoots(db,event.todo_id)
     :clockUuid(nativeId)?await clockRoots(db,nativeId):[];
    if(!roots.some(root=>root.scenarioId===id)||event.event_kind==='material_investment'&&roots.some(root=>root.scenarioId!==id))continue;
    if(!await this.runtime.isUat(event.recipient_id))throw new Error('Scene notification escaped UAT recipient boundary');
    count+=(await db.query(`INSERT INTO acceptance_sla_clock_receipts(receipt_id,scenario_id,native_kind,native_event_id,recipient_id,business_time,details_json)
     VALUES($1,$2,'digital',$3,$4,$5,$6) ON CONFLICT DO NOTHING`,[randomUUID(),id,event.event_id,event.recipient_id,row.business_now,JSON.stringify({kind:event.event_kind})])).rowCount??0;
   }
   const result={newTestReceipts:count,clockVersion:row.version,businessTime:row.business_now.toISOString(),timing,mayHaveMore:timing.claimed===50||timing.overdueCandidates===50};
   await db.query("UPDATE acceptance_sla_clock_scans SET status='completed',result_json=$2,finished_at=CURRENT_TIMESTAMP WHERE scan_id=$1",[scanId,JSON.stringify(result)]);
   return {status:'completed',result,message:null};
  }catch(error){
   await db.query("UPDATE acceptance_sla_clock_scans SET status='failed',error_message='提醒扫描失败，请查看测试服务日志后重试',finished_at=CURRENT_TIMESTAMP WHERE scan_id=$1",[scanId]);
   throw error;
  }
 }
}
