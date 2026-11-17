import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {z} from 'zod';
import {FrozenOrderTimePlanSchema,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
import type {RootAuthority} from '../access/root-authority.js';
import {digitalForbidden} from './access-policy.js';
import {OrderTimeRequestRepository} from './order-time-request-repository.js';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
import {fixedTimelineIdentity} from './fixed-timeline-identity.js';

const inputSchema=z.object({requestId:z.uuid(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),reason:z.string().trim().min(1).max(500)}).strict();
type Proof={requestId:string;requestVersion?:number;sourceId?:string;orderId?:string;sourcePlanId?:string;orderPlanId?:string;sourceIdentity?:string;orderIdentity?:string;approvalEventRef?:string;approvalReceiptHash?:string;effective?:boolean|null;sourceState?:string;orderState?:string};
export type OrderTimeScopeRecoveryPreview={state:'blocked'|'ready'|'already_consistent';proof:Proof;fingerprint:string;blockers:string[]};
const conflict=(code:string,message:string):never=>{throw new ApplicationError(code,message,409);};
// Local plan revisions differ across resources. Compare every frozen policy
// field, while preserving each resource's independent revision and identity.
const policyIdentity=(plan:FrozenOrderTimePlan)=>fixedTimelineIdentity({...plan,revision:undefined});

/** Internal maintenance adapter, deliberately not a business route. Existing
 * frozen source evidence is mandatory: a missing source plan is a blocker,
 * never a reason to rebuild history from today's company settings or clock. */
export class OrderTimeScopeRecoveryService{
 constructor(private readonly database:Pool,private readonly rootAuthority:RootAuthority){}
 private async transaction<T>(write:boolean,actor:TrustedActorContext,work:(db:PoolClient)=>Promise<T>){
  const db=await this.database.connect();try{
   await db.query(write?'BEGIN':'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   if(!isRootActor(actor)||!await this.rootAuthority.isRootUser(actor.actorId,db,write))digitalForbidden();
   if(write)await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const result=await work(db);await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 private async inspect(db:PoolClient,requestId:string,lock=false):Promise<OrderTimeScopeRecoveryPreview>{
  const proof:Proof={requestId},blockers:string[]=[];
  const result=():OrderTimeScopeRecoveryPreview=>({state:blockers.length?'blocked':proof.effective?'already_consistent':'ready',proof,fingerprint:fixedTimelineIdentity(proof),blockers});
  const stop=(reason:string)=>{blockers.push(reason);return result();};
  const row=await new OrderTimeRequestRepository(db).read(requestId,lock);
  if(!row||row.state!=='applied')return stop('原申请不是已生效的批准记录');
  proof.requestVersion=row.version;
  const operation=row.operation_json;
  if(!['development_publish','confirm_order'].includes(operation.kind)||!('sourceId'in operation)||row.source_id!==operation.sourceId)return stop('原批准不具备唯一的开发来源范围');
  proof.sourceId=operation.sourceId;
  if(!row.applied_plan_id||!row.result_order_id)return stop('原申请缺少准确的采用引用或原生订单回执');
  proof.orderId=row.result_order_id;
  const order=(await db.query(`SELECT source_id FROM digital_production_orders WHERE production_order_id=$1 ${lock?'FOR UPDATE':''}`,[proof.orderId])).rows[0];
  const source=(await db.query(`SELECT created_by FROM digital_production_sources WHERE source_id=$1 ${lock?'FOR UPDATE':''}`,[proof.sourceId])).rows[0];
  if(order?.source_id!==proof.sourceId||source?.created_by!==row.designer_id)return stop('原申请、订单和开发来源身份不一致');
  const repo=new OrderTimePlanRepository(db),sourcePlan=await repo.current({kind:'source',id:proof.sourceId}),orderPlan=await repo.current({kind:'order',id:proof.orderId});
  if(!sourcePlan)return stop('缺少原批准开发方案，不能凭订单或当前标准补造历史采用');
  if(!orderPlan||orderPlan.id!==row.applied_plan_id)return stop('订单已有其他采用或原采用不存在，须另行核实');
  Object.assign(proof,{sourcePlanId:sourcePlan.id,orderPlanId:orderPlan.id,sourceIdentity:sourcePlan.identityHash,orderIdentity:orderPlan.identityHash,approvalEventRef:orderPlan.eventRef});
  if(sourcePlan.identityHash!==fixedTimelineIdentity({input:sourcePlan.input,targets:sourcePlan.targets})||orderPlan.identityHash!==fixedTimelineIdentity({input:orderPlan.input,targets:orderPlan.targets}))return stop('原冻结方案指纹不一致');
  if(sourcePlan.eventRef!==orderPlan.eventRef||sourcePlan.actorId!==row.applied_by||orderPlan.actorId!==row.applied_by||policyIdentity(sourcePlan.input.plan)!==policyIdentity(orderPlan.input.plan)||fixedTimelineIdentity(sourcePlan.time)!==fixedTimelineIdentity(orderPlan.time))return stop('两个资源的原批准、冻结用时或时间来源不一致');
  const eventId=orderPlan.eventRef.match(/^audit_events:([0-9a-f-]{36})$/i)?.[1];
  const audit=eventId?(await db.query("SELECT actor_id,after_state FROM audit_events WHERE id=$1 AND action='order_time_activated'",[eventId])).rows[0]:null;
  const approvedPlan=FrozenOrderTimePlanSchema.safeParse(audit?.after_state?.plan);
  if(audit?.actor_id!==row.applied_by||audit?.after_state?.requestId!==requestId||!approvedPlan.success||policyIdentity(approvedPlan.data)!==policyIdentity(sourcePlan.input.plan)||fixedTimelineIdentity(audit?.after_state?.operation??null)!==fixedTimelineIdentity(operation))return stop('没有匹配本次原业务批准及其冻结方案的审计依据');
  const receipts=(await db.query(`SELECT actor_id,command,key,payload_hash FROM digital_production_commands
    WHERE actor_id=$1 AND command=$2 AND response->>'requestId'=$3 AND response->>'state'='applied'
      AND response->>'version'=$4 AND response->'result'->>'orderId'=$5`,[row.applied_by,'order-time:apply:'+requestId,requestId,String(row.version),proof.orderId])).rows;
  if(receipts.length!==1)return stop('原批准命令回执缺失或不唯一，不能推定原提交终态');
  proof.approvalReceiptHash=fixedTimelineIdentity(receipts[0]);
  const states=(await db.query(`SELECT resource_kind,state FROM digital_production_resource_lifecycle WHERE (resource_kind='source' AND resource_id=$1) OR (resource_kind='order' AND resource_id=$2)`,[proof.sourceId,proof.orderId])).rows;
  proof.sourceState=states.find(x=>x.resource_kind==='source')?.state??'active';proof.orderState=states.find(x=>x.resource_kind==='order')?.state??'active';
  if(proof.sourceState!=='active'||proof.orderState!=='active'||(await db.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[proof.orderId])).rowCount)return stop('资源已暂停、取消或特殊结案，不恢复办理资格');
  const subjects=(await db.query(`SELECT resource_kind,effective FROM digital_order_time_subjects WHERE (resource_kind='source' AND source_id=$1) OR (resource_kind='order' AND production_order_id=$2) ${lock?'FOR UPDATE':''}`,[proof.sourceId,proof.orderId])).rows;
  const sourceSubject=subjects.find(s=>s.resource_kind==='source'),orderSubject=subjects.find(s=>s.resource_kind==='order');
  proof.effective=sourceSubject?.effective??null;
  if(!sourceSubject||orderSubject?.effective!==true)return stop('原资格行缺失或订单本身尚未生效');
  return result();
 }
 preview(actor:TrustedActorContext,requestId:string){z.uuid().parse(requestId);return this.transaction(false,actor,db=>this.inspect(db,requestId));}
 recover(actor:TrustedActorContext,raw:unknown,key:string){
  const input=inputSchema.parse(raw);z.string().min(1).max(200).parse(key);
  return this.transaction(true,actor,async db=>{
   const command='order-time-scope-recovery:'+input.requestId,digest=fixedTimelineIdentity(input);
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior){if(prior.payload_hash!==digest)conflict('ORDER_TIME_CONFLICT','恢复标识已用于不同内容');return prior.response;}
   const preview=await this.inspect(db,input.requestId,true);
   if(preview.state==='blocked')conflict('ORDER_TIME_RECOVERY_BLOCKED',preview.blockers.join('；'));
   if(preview.fingerprint!==input.fingerprint)conflict('ORDER_TIME_STALE','恢复依据已变化，未修改任何资格，请重新只读核实');
   let auditId:string|null=null;
   if(preview.state==='ready'){
    if((await db.query("UPDATE digital_order_time_subjects SET effective=true WHERE resource_kind='source' AND source_id=$1 AND effective=false",[preview.proof.sourceId])).rowCount!==1)conflict('ORDER_TIME_STALE','开发资格已由其他操作更新');
    auditId=randomUUID();await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
     VALUES($1,$2,$3,'order_time_scope_consistency_recovered','digital_production',$4,$5)`,[auditId,actor.requestId,actor.actorId,preview.proof.sourceId,JSON.stringify({original:preview.proof,reason:input.reason,beforeEffective:false,afterEffective:true,change:'eligibility_only'})]);
   }
   const response={requestId:input.requestId,sourceId:preview.proof.sourceId,changed:preview.state==='ready',auditId};
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,digest,JSON.stringify(response)]);
   return response;
  });
 }
}
