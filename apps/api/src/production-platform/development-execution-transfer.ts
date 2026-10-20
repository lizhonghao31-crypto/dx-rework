import type {Pool,PoolClient} from 'pg';
import {randomUUID} from 'node:crypto';
import {authorizePatternOrder} from '../pattern-room/order-authority.js';
import {DigitalProductionTaskService} from './task-service.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {DevelopmentExecutionTransfer} from '@dx-rework/contracts/development-arrangement';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {ApplicationError} from '../platform/errors.js';
import {arrangementsAvailable,readArrangement} from './development-arrangement.js';
const conflict=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_EXECUTION_CONFLICT',message,409);};
export async function validateExecutionTransfer(db:PoolClient,actor:TrustedActorContext,sourceId:string,input:DevelopmentExecutionTransfer){
 const linked=(await db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0];
 if(linked?.order_id!==input.orderId)conflict('执行单不属于本开发单，本次未提交；请重新打开本单总委派');
 const plan=await readArrangement(db,actor,sourceId);
 if(!plan||plan.roundNumber!==input.roundNumber||plan.documentVersion!==input.expectedDocumentVersion||plan.version!==input.expectedArrangementVersion)conflict('制作轮次、资料或人员安排已变化，本次未提交；请重新读取本单');
 const row=plan!.rows.find(row=>row.kind==='development_sewing'),expected=input.expectedTask;
 if(!row||!row.editable||(row.taskId===null)!==(expected===null)||expected&&(row.taskId!==expected.taskId||row.state!==expected.state||row.assigneeId!==expected.assigneeId))conflict('本轮车板任务已变化或结束，未改写人员或执行段；请重新读取');
 return plan!;
}
/** Native endpoint and the unified adapter share this transaction; no front-end two-write illusion. */
export async function syncLinkedExecutionTransfer(db:PoolClient,database:Pool,actor:TrustedActorContext,orderId:string,oldUserId:string,nextUserId:string,reason:string,nativeAction:"assign"|"transfer"="transfer"){
 if(!await arrangementsAvailable(db))return false;
 const link=(await db.query('SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1',[orderId])).rows[0];if(!link)return false;
 await new DigitalProductionAccessPolicy(db).assert(actor,'source',link.source_id,'technical');
 const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[link.source_id])).rows[0];
 if(lifecycle&&lifecycle.state!=='active')conflict('开发单已暂停或取消，未更改执行段；请有权管理人员先核实本单状态');
 await authorizePatternOrder(db,actor,nativeAction==='assign'?'pattern_room:orders:assign':'pattern_room:orders:transfer',true);
 if(nativeAction==='assign'&&!(await db.query("SELECT 1 FROM pattern_room_orders o JOIN pattern_room_rounds r ON r.round_id=o.current_round_id WHERE o.order_id=$1 AND r.round_type='rework'",[orderId])).rowCount)conflict('首次车板不能借返工核价入口重新派工');
 const plan=await readArrangement(db,actor,link.source_id);if(!plan)conflict('未取得本单有效安排权限，执行段与人员安排均未更改');
 const sewing=plan!.rows.find(row=>row.kind==='development_sewing');
 // Pre-arrangement native work can legally predate its digital sewing task. Keep
 // the original native operation; do not manufacture a task or a passed check.
 if(plan!.version===0&&!sewing?.taskId&&!plan!.readyToArrange)return false;
 if(!sewing?.editable)return conflict('当前制作轮没有可改派的车板任务，未改写已结束人员或执行段；请核对制作轮次');
 if(sewing.assigneeId&&sewing.assigneeId!==oldUserId)conflict('当前车板任务与原执行人不一致，未覆盖已有安排；请主管核对本单实际记录');
 const entries=Object.fromEntries(plan!.rows.map(row=>[row.kind,row.kind==='development_sewing'?nextUserId:row.assigneeId]));
 await db.query(`INSERT INTO digital_development_round_arrangements(source_id,round_number,version,entries,manager_id,changed_by,document_version)
 VALUES($1,$2,1,$3,$4,$5,$6) ON CONFLICT(source_id,round_number) DO UPDATE SET version=digital_development_round_arrangements.version+1,entries=excluded.entries,changed_by=excluded.changed_by,document_version=excluded.document_version,changed_at=CURRENT_TIMESTAMP`,[link.source_id,plan!.roundNumber,JSON.stringify(entries),plan!.managerId,actor.actorId,plan!.documentVersion]);
 if(sewing.taskId)await new DigitalProductionTaskService(database).syncNativeSewingWithClient(db,actor,sewing.taskId,orderId,nextUserId,nativeAction);
 await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
 VALUES($1,$2,$3,'development_round_arranged','digital_development',$4,$5,$6)`,[randomUUID(),actor.requestId,actor.actorId,link.source_id,JSON.stringify(plan),JSON.stringify({roundNumber:plan!.roundNumber,version:plan!.version+1,entries,managerId:plan!.managerId,nativeOrderId:orderId,nativeAction,reason})]);
 return true;
}

/** Rework assignment keeps the saved personnel plan; changing it remains an explicit arrangement action. */
export async function linkedAssignmentContext(db:PoolClient,actor:TrustedActorContext,orderId:string,nextUserId:string,root:boolean){
 if(!await arrangementsAvailable(db))return null;
 const link=(await db.query('SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1',[orderId])).rows[0];if(!link)return null;
 await new DigitalProductionAccessPolicy(db).assert(actor,'source',link.source_id,'technical');
 const plan=await readArrangement(db,actor,link.source_id),row=plan?.rows.find(row=>row.kind==='development_sewing');
 if(!plan||!row?.editable)return null;
 if(!root&&row.assigneeId&&row.assigneeId!==nextUserId)conflict('本轮车板已有人员安排，请先在本单总委派明确改派并保存原因，再核定返工执行金额');
 return {plan,workerId:row.assigneeId};
}
