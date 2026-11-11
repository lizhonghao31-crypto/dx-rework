import {randomUUID,createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import type {OrderTimeOperation,OrderTimeRequestState,OrderTimeCheckResult} from '@dx-rework/contracts/order-time-requests';
import type {OrderTimeStandard} from '@dx-rework/contracts/order-time-plan';
import {ApplicationError} from '../platform/errors.js';

type DB=Pick<PoolClient,'query'>;
export type OrderTimeRequestRow={request_id:string;source_id:string|null;production_order_id:string|null;state:OrderTimeRequestState;version:number;
 requested_by:string;designer_id:string;operation_json:OrderTimeOperation;company_snapshot:OrderTimeStandard;submitted_versions:Record<string,unknown>;submitted_fingerprint:string;
 reason:string;return_reason:string|null;applied_by:string|null;applied_plan_id:string|null;result_order_id:string|null;result_late_minutes:string|null;requested_name?:string|null;applied_name?:string|null};
const conflict=(message:string):never=>{throw new ApplicationError('ORDER_TIME_CONFLICT',message,409);};
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Original command owns BEGIN/COMMIT, actor/scope and native side effects.
 * One locked request is the race boundary; no whole-order rebuilding in reads. */
export class OrderTimeRequestRepository{
 constructor(private readonly db:DB){}
 async read(id:string,lock=false):Promise<OrderTimeRequestRow|null>{
  return (await this.db.query<OrderTimeRequestRow>(`SELECT r.*,requester.display_name AS requested_name,applier.display_name AS applied_name
   FROM digital_order_time_requests r JOIN app_users requester ON requester.id=r.requested_by LEFT JOIN app_users applier ON applier.id=r.applied_by
   WHERE r.request_id=$1 ${lock?'FOR UPDATE OF r':''}`,[id])).rows[0]??null;
 }
 async create(input:{operation:OrderTimeOperation;check:OrderTimeCheckResult;actorId:string;designerId:string;reason:string;time:BusinessTime;needsDesigner?:boolean}){
  const id=randomUUID(),resource=input.check.resource,state=input.needsDesigner?'needs_designer':'pending';
  if(resource.kind!=='proposal'){
   const prior=(await this.db.query<{request_id:string}>(`SELECT request_id FROM digital_order_time_requests WHERE ${resource.kind==='source'?'source_id':'production_order_id'}=$1 AND state IN ('needs_designer','pending','returned','withdrawn') ORDER BY updated_at DESC,request_id DESC LIMIT 1 FOR UPDATE`,[resource.id])).rows[0];
   if(prior){const existing=(await this.read(prior.request_id))!;
    if(existing.designer_id!==input.designerId||existing.operation_json.kind!==input.operation.kind)conflict('本单已有其他变更正在申请，请先处理原申请');
    if(['returned','withdrawn','needs_designer'].includes(existing.state)&&!input.needsDesigner)return this.resubmit(existing,{expectedVersion:existing.version,actorId:input.actorId,operation:input.operation,check:input.check,reason:input.reason,time:input.time});
    return existing;
   }
  }
  const row=(await this.db.query<OrderTimeRequestRow>(`INSERT INTO digital_order_time_requests(request_id,source_id,production_order_id,state,requested_by,designer_id,operation_json,company_snapshot,submitted_versions,submitted_fingerprint,reason)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,[id,resource.kind==='source'?resource.id:null,resource.kind==='order'?resource.id:null,state,input.actorId,input.designerId,JSON.stringify(input.operation),JSON.stringify(input.check.plan.company),JSON.stringify(input.check.sourceVersion),input.check.fingerprint,input.reason])).rows[0]!;
  await this.event(row,input.actorId,input.needsDesigner?'handed_to_designer':'submitted',input.time,{operation:input.operation,checkFingerprint:input.check.fingerprint});return row;
 }
 async resubmit(row:OrderTimeRequestRow,input:{expectedVersion:number;actorId:string;operation:OrderTimeOperation;check:OrderTimeCheckResult;reason:string;time:BusinessTime}){
  this.version(row,input.expectedVersion);if(!['needs_designer','returned','withdrawn'].includes(row.state))conflict('本单申请已在办理，请先刷新');
  const updated=(await this.db.query<OrderTimeRequestRow>(`UPDATE digital_order_time_requests SET state='pending',version=version+1,requested_by=$2,
   operation_json=$3,company_snapshot=$4,submitted_versions=$5,submitted_fingerprint=$6,reason=$7,return_reason=NULL,updated_at=CURRENT_TIMESTAMP
   WHERE request_id=$1 AND version=$8 RETURNING *`,[row.request_id,input.actorId,JSON.stringify(input.operation),JSON.stringify(input.check.plan.company),JSON.stringify(input.check.sourceVersion),input.check.fingerprint,input.reason,row.version])).rows[0]??conflict('申请已更新，请刷新');
  await this.event(updated,input.actorId,'submitted',input.time,{operation:input.operation,previousState:row.state});return updated;
 }
 async finish(row:OrderTimeRequestRow,input:{expectedVersion:number;actorId:string;planId:string;orderId:string|null;lateMinutes:number|null;time:BusinessTime}){
  this.version(row,input.expectedVersion);if(row.state!=='pending')conflict('本单申请已处理，请刷新查看结果');
  const updated=(await this.db.query<OrderTimeRequestRow>(`UPDATE digital_order_time_requests SET state='applied',version=version+1,applied_by=$2,applied_plan_id=$3,
   result_order_id=$4,result_late_minutes=$5,updated_at=CURRENT_TIMESTAMP WHERE request_id=$1 AND version=$6 AND state='pending' RETURNING *`,[row.request_id,input.actorId,input.planId,input.orderId,input.lateMinutes,row.version])).rows[0]??conflict('本单申请已由其他人处理');
  await this.event(updated,input.actorId,'applied',input.time,{planId:input.planId,orderId:input.orderId,lateMinutes:input.lateMinutes});return updated;
 }
 async close(row:OrderTimeRequestRow,input:{expectedVersion:number;actorId:string;state:'returned'|'withdrawn';reason?:string;time:BusinessTime}){
  this.version(row,input.expectedVersion);if(!['needs_designer','pending','returned'].includes(row.state))conflict('本单申请已处理，请刷新');
  const updated=(await this.db.query<OrderTimeRequestRow>(`UPDATE digital_order_time_requests SET state=$2,version=version+1,return_reason=$3,updated_at=CURRENT_TIMESTAMP
   WHERE request_id=$1 AND version=$4 RETURNING *`,[row.request_id,input.state,input.reason??null,row.version])).rows[0]??conflict('申请已更新，请刷新');
  await this.event(updated,input.actorId,input.state,input.time,{reason:input.reason??null});return updated;
 }
 private version(row:OrderTimeRequestRow,expected:number){if(row.version!==expected)conflict('申请已更新，本次填写已保留，请刷新后核对');}
 private async event(row:OrderTimeRequestRow,actorId:string,action:string,time:BusinessTime,payload:unknown){
  await this.db.query(`INSERT INTO digital_order_time_request_events(event_id,request_id,request_version,actor_id,action,payload,business_time)
   VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),row.request_id,row.version,actorId,action,JSON.stringify(payload),JSON.stringify(time)]);
 }
 async receipt<T>(actorId:string,action:string,key:string,input:unknown,work:()=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效操作标识',400);
  const command='order-time:'+action,digest=hash(input);
  await this.db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[JSON.stringify([actorId,command,key])]);
  const prior=(await this.db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actorId,command,key])).rows[0];
  if(prior){if(prior.payload_hash!==digest)conflict('原操作标识不能用于其他内容');return prior.response as T;}
  const result=await work();await this.db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actorId,command,key,digest,JSON.stringify(result)]);return result;
 }
}
