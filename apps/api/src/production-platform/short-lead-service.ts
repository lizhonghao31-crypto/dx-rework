import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {ShortLeadRequestSchema,ShortLeadDecisionSchema,shortLeadFactChanges,type ShortLeadRequest,type ShortLeadState} from '@dx-rework/contracts/short-commitment';
import {formalCommitmentFacts,DigitalOrderCreateSchema,initialCustomerOrderInput,customerOrderDateError,beijingCalendarDate,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {isRootActor} from '../access/business-authority.js';
import {ApplicationError} from '../platform/errors.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ContextBusinessClock,observedBusinessTime} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {commitmentHash,shortLeadAvailable,shortLeadStaleReason,shortLeadDocumentHash} from './short-lead-evidence.js';
import {acceptsNewOrderTime} from './order-time-admission.js';
type DB=Pick<Pool|PoolClient,'query'>;
const conflict=(message:string):never=>{throw new ApplicationError('SHORT_LEAD_CONFLICT',message,409);};
const dtoDate=(value:Date|string)=>new Date(value).toISOString();
/** The short-lead exception is independent of ordinary plan changes and boardroom urgency. */
export class ShortLeadService{
 constructor(private readonly database:Pool){}
 private async authority(db:DB,actor:TrustedActorContext,write=false):Promise<'owner_group'|'root_superuser'|null>{
  if(isRootActor(actor))return 'root_superuser';
  const p=new DigitalProductionAccessPolicy(db);
  return actor.actorRoles.includes('owner_group')&&await(write?p.lockActiveRole(actor.actorId,'owner_group'):p.activeRole(actor.actorId,'owner_group'))?'owner_group':null;
 }
 private async source(db:DB,actor:TrustedActorContext,id:string|null){
  if(!id)return null;await new DigitalProductionAccessPolicy(db).assert(actor,'source',id,'technical');
  return (await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1',[id])).rows[0]??digitalNotFound();
 }
 private async canRequest(db:DB,actor:TrustedActorContext,id:string|null,write=false){
  const source=await this.source(db,actor,id);if(isRootActor(actor))return true;
  const p=new DigitalProductionAccessPolicy(db);
  return (!source||source.created_by===actor.actorId)&&actor.actorRoles.includes('sample_designer')&&(actor.authorizationCapabilities??[]).includes('pattern_room:orders:create')
    &&await(write?p.lockActiveRole(actor.actorId,'sample_designer'):p.activeRole(actor.actorId,'sample_designer'));
 }
 private async time(db:PoolClient|undefined,id:string|null){return id?new ContextBusinessClock(this.database,db).read({kind:'source',id}):observedBusinessTime();}
 private async active(db:DB,id:string|null){
  if(!id)return;
  if((await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1 AND state<>'active'",[id])).rowCount)conflict('开发来源已暂停或取消');
  if((await db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[id])).rowCount)conflict('本来源已正式下单，请到原订单办理日期变更');
 }
 private async audit(db:PoolClient,actor:TrustedActorContext,id:string,action:string,after:unknown){
  const eventId=randomUUID();await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_production',$5,$6)",[eventId,actor.requestId,actor.actorId,action,id,JSON.stringify(after)]);return eventId;
 }
 private async command<T>(actor:TrustedActorContext,sourceId:string|null,kind:string,key:string,input:unknown,authorize:(db:PoolClient)=>Promise<unknown>,work:(db:PoolClient)=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效操作标识',400);
  const db=await this.database.connect();try{
   await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   if(!await shortLeadAvailable(db))conflict('短交期审批尚未迁移就绪');await this.source(db,actor,sourceId);await authorize(db);
   if(await acceptsNewOrderTime(db))throw new ApplicationError('ORDER_TIME_REQUEST_REQUIRED','请回原单按实际工艺提交本单时效申请，原申请仅保留历史记录',409);
   const scopeTime=await this.time(db,sourceId);
   const command=`short-lead:${sourceId??'direct'}:${scopeTime.scenarioId??'real'}:${kind}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)conflict('同一操作标识不能用于不同资料');
   const result=prior?prior.response as T:await work(db);
   if(!prior)await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   await db.query('COMMIT');return result;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async read(actor:TrustedActorContext,sourceId:string|null=null):Promise<ShortLeadState>{
  await this.source(this.database,actor,sourceId);
  const canApprove=Boolean(await this.authority(this.database,actor)),canRequest=await this.canRequest(this.database,actor,sourceId),time=await this.time(undefined,sourceId);
  // Non-approving managers can open the shared settings shell, but do not receive others' applications.
  const rows=await shortLeadAvailable(this.database)?(await this.database.query(`SELECT r.*,r.commitment_day::text AS commitment_day,r.commitment_day::text AS day,r.minimum_normal_date::text AS minimum,
   u.display_name AS requester_name,d.approved,d.reason AS decision_reason,d.decided_by,d.authority,d.recorded_at AS decided_at,du.display_name AS decider_name,c.production_order_id AS consumed_order_id
   FROM digital_short_lead_requests r JOIN app_users u ON u.id=r.requested_by LEFT JOIN digital_short_lead_decisions d USING(request_id)
   LEFT JOIN app_users du ON du.id=d.decided_by LEFT JOIN digital_short_lead_consumptions c USING(request_id)
   WHERE ($1::uuid IS NULL OR r.source_id=$1) AND ($2::boolean OR r.requested_by=$3)
   AND coalesce(r.business_time->>'scenarioId','')=coalesce($4::text,'') ORDER BY r.recorded_at DESC,r.request_id DESC LIMIT 100`,[sourceId,canApprove,actor.actorId,time.scenarioId])).rows:[];
  const visible=rows.filter(r=>(r.business_time?.scenarioId??null)===time.scenarioId);
  const requests:ShortLeadRequest[]=await Promise.all(visible.map(async r=>{const sheet=r.source_id?await developmentDocumentRow(this.database,r.source_id):null;let changes:string[]=[];try{const draft=sheet?.document?.customerOrderDraft;if(draft?.withOrder)changes=shortLeadFactChanges(formalCommitmentFacts(r.order_facts),formalCommitmentFacts(DigitalOrderCreateSchema.parse(initialCustomerOrderInput(draft.order))));}catch{/* An incomplete current draft has no complete customer facts to compare. */}if(sheet&&shortLeadDocumentHash(sheet.document)!==r.source_document_fingerprint&&!changes.length)changes=['开发资料完整内容指纹已改变；原申请未保存逐字段技术快照，请回原单核对'];return {canDecide:canApprove&&(r.requested_by!==actor.actorId||isRootActor(actor)),sourceDocumentVersion:r.source_document_version??null,currentDocumentVersion:sheet?.version??null,changes,requestId:r.request_id,sourceId:r.source_id,customerCode:r.customer_code,designStyleNo:r.design_style_no,
   order:r.order_facts,facts:formalCommitmentFacts(r.order_facts),commitmentDay:r.day,minimumNormalDate:r.minimum,reason:r.reason,
   requestedBy:r.requested_by,requesterName:r.requester_name,requestedAt:dtoDate(r.recorded_at),consumedOrderId:r.consumed_order_id??null,
   staleReason:r.consumed_order_id?null:await shortLeadStaleReason(this.database,r),decision:r.approved===null?null:{approved:r.approved,reason:r.decision_reason,decidedBy:r.decided_by,deciderName:r.decider_name,authority:r.authority,decidedAt:dtoDate(r.decided_at)}};}));
  const now=new Date(time.now),replaced=await acceptsNewOrderTime(this.database);return {canApprove:!replaced&&canApprove,canRequest:!replaced&&canRequest,serverToday:beijingCalendarDate(now),minimumNormalDate:minimumInitialCustomerDate(now),requests};
 }
 async request(actor:TrustedActorContext,sourceId:string|null,raw:unknown,key:string){
  const parsed=ShortLeadRequestSchema.safeParse(raw);if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR',parsed.error.issues[0]?.message??'订单资料不完整',400);
  const input=parsed.data;delete input.order.shortLeadApprovalId;
  return this.command(actor,sourceId,'request',key,input,async db=>{if(!await this.canRequest(db,actor,sourceId,true))digitalForbidden();},async db=>{
   await this.active(db,sourceId);const time=await this.time(db,sourceId),now=new Date(time.now),day=beijingCalendarDate(now),minimum=minimumInitialCustomerDate(now);
   const facts=formalCommitmentFacts(input.order);
   if(customerOrderDateError(input.order.orderDate,day))throw new ApplicationError('VALIDATION_ERROR','客户下单日期不能晚于服务器业务日期',400);
   if(facts.lines.some(p=>!p.customerDate||!isCalendarDate(p.customerDate)||p.customerDate<input.order.orderDate))throw new ApplicationError('VALIDATION_ERROR','每个PO均需有效客户约定出货日期，且不能早于客户下单日期',400);
   if(facts.lines.every(p=>p.customerDate!>=minimum))conflict('本单已满足30自然日，不需要短交期特批');
   const source=await this.source(db,actor,sourceId),sheet=sourceId?await developmentDocumentRow(db,sourceId):null;
   if(source&&(source.design_style_no!==input.order.designStyleNo||source.customer_code&&source.customer_code!==input.order.customerCode))conflict('申请资料与开发来源不一致');
   if(!(await db.query('SELECT 1 FROM digital_production_customers WHERE code=$1 AND enabled',[input.order.customerCode])).rowCount)throw new ApplicationError('VALIDATION_ERROR','客户不可用',400);
   const hash=commitmentHash(input.order),stale=await shortLeadStaleReason(db,{source_id:sourceId,source_document_version:sheet?.version??null,facts_hash:hash,source_document_fingerprint:sheet?.document?shortLeadDocumentHash(sheet.document):null,source_document_status:sheet?.status??null,commitment_day:day,business_time:time});if(stale)conflict(stale);
   const prior=(await db.query(`SELECT r.*,r.commitment_day::text AS commitment_day FROM digital_short_lead_requests r LEFT JOIN digital_short_lead_decisions d USING(request_id) LEFT JOIN digital_short_lead_consumptions c USING(request_id)
    WHERE r.source_id IS NOT DISTINCT FROM $1::uuid AND r.requested_by=$2 AND r.facts_hash=$3 AND d.approved IS DISTINCT FROM false AND c.request_id IS NULL AND coalesce(r.business_time->>'scenarioId','')=coalesce($4::text,'') ORDER BY r.recorded_at DESC LIMIT 1`,[sourceId,actor.actorId,hash,time.scenarioId])).rows[0];
   if(prior&&!await shortLeadStaleReason(db,prior))return {requestId:prior.request_id};
   const requestId=randomUUID(),auditId=await this.audit(db,actor,sourceId??requestId,'short_lead_requested',{requestId,sourceId,facts,commitmentDay:day,minimumNormalDate:minimum,reason:input.reason});
   await db.query(`INSERT INTO digital_short_lead_requests(request_id,source_id,customer_code,design_style_no,facts_hash,order_facts,commitment_day,minimum_normal_date,source_document_version,source_document_fingerprint,source_document_status,reason,requested_by,business_time,audit_event_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,[requestId,sourceId,input.order.customerCode,input.order.designStyleNo,hash,JSON.stringify(input.order),day,minimum,sheet?.version??null,sheet?.document?shortLeadDocumentHash(sheet.document):null,sheet?.status??null,input.reason,actor.actorId,JSON.stringify(time),auditId]);
   return {requestId};
  });
 }
 async decide(actor:TrustedActorContext,sourceId:string|null,requestId:string,raw:unknown,key:string){
  const parsed=ShortLeadDecisionSchema.safeParse(raw);if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR','请填写决定和原因',400);
  const input=parsed.data;
  return this.command(actor,sourceId,`decision:${requestId}`,key,input,async db=>{if(!await this.authority(db,actor,true))digitalForbidden();},async db=>{
   const row=(await db.query('SELECT *,commitment_day::text AS commitment_day FROM digital_short_lead_requests WHERE request_id=$1 FOR UPDATE',[requestId])).rows[0];
   if(!row||row.source_id!==sourceId)digitalNotFound();
   const time=await this.time(db,sourceId);
   if((row.business_time?.scenarioId??null)!==time.scenarioId)digitalNotFound();
   if(row.requested_by===actor.actorId&&!isRootActor(actor))digitalForbidden();
   const prior=(await db.query('SELECT * FROM digital_short_lead_decisions WHERE request_id=$1',[requestId])).rows[0];
   if(prior){if(prior.approved!==input.approved||prior.decided_by!==actor.actorId||prior.reason!==input.reason)conflict('申请已决定，原决定保留');return {requestId,approved:prior.approved};}
   if(input.approved){
    await this.active(db,sourceId);
    const stale=await shortLeadStaleReason(db,row);if(stale)conflict(stale);
   }
   const authority=(await this.authority(db,actor,true))!,auditId=await this.audit(db,actor,sourceId??requestId,'short_lead_decided',{requestId,...input,authority,commitmentDay:row.commitment_day});
   await db.query('INSERT INTO digital_short_lead_decisions(request_id,approved,reason,decided_by,authority,business_time,audit_event_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[requestId,input.approved,input.reason,actor.actorId,authority,JSON.stringify(time),auditId]);
   return {requestId,approved:input.approved};
  });
 }
}
