import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {DevelopmentArrangement,DevelopmentArrangementInput,DevelopmentExecutionTransfer} from '@dx-rework/contracts/development-arrangement';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {ApplicationError} from '../platform/errors.js';
import {arrangementsAvailable,readArrangement,saveArrangement} from './development-arrangement.js';
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
function transferEntries(plan:DevelopmentArrangement,nextUserId:string,reason:string){
 return plan.rows.map(row=>({kind:row.kind as DevelopmentArrangementInput['entries'][number]['kind'],assigneeId:row.kind==='development_sewing'?nextUserId:row.assigneeId,expectedTask:row.taskId?{taskId:row.taskId,state:row.state!,assigneeId:row.assigneeId}:null,reason:row.kind==='development_sewing'?reason:''}));
}
/** Native endpoint and the unified adapter share this transaction; no front-end two-write illusion. */
export async function syncLinkedExecutionTransfer(db:PoolClient,database:Pool,actor:TrustedActorContext,orderId:string,oldUserId:string,nextUserId:string,reason:string){
 if(!await arrangementsAvailable(db))return false;
 const link=(await db.query('SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1',[orderId])).rows[0];if(!link)return false;
 await new DigitalProductionAccessPolicy(db).assert(actor,'source',link.source_id,'technical');
 const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[link.source_id])).rows[0];
 if(lifecycle&&lifecycle.state!=='active')conflict('开发单已暂停或取消，未更改执行段；请有权管理人员先核实本单状态');
 const plan=await readArrangement(db,actor,link.source_id);if(!plan)conflict('未取得本单有效安排权限，执行段与人员安排均未更改');
 const sewing=plan!.rows.find(row=>row.kind==='development_sewing');
 // Pre-arrangement native work can legally predate its digital sewing task. Keep
 // the original native operation; do not manufacture a task or a passed check.
 if(plan!.version===0&&!sewing?.taskId&&!plan!.readyToArrange)return false;
 if(!sewing?.editable)return conflict('当前制作轮没有可改派的车板任务，未改写已结束人员或执行段；请核对制作轮次');
 if(sewing.assigneeId&&sewing.assigneeId!==oldUserId)conflict('当前车板任务与原执行人不一致，未覆盖已有安排；请主管核对本单实际记录');
 await saveArrangement(db,database,actor,link.source_id,{roundNumber:plan!.roundNumber,expectedDocumentVersion:plan!.documentVersion,expectedVersion:plan!.version,entries:transferEntries(plan!,nextUserId,reason),management:'keep',managementReason:''});
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
