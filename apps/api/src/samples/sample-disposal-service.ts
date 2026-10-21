import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SampleDisposalRequestSchema,SampleDisposalDecisionSchema,SampleLossCloseSchema,SampleBasicUpdateSchema,SampleLocationUpdateSchema,SampleFinanceCorrectionSchema,SampleArchiveSchema,SampleDisposalActionsSchema,SamplePeopleResponseSchema,SampleFinancialAuditResponseSchema,type SampleCapability} from '@dx-rework/contracts';
import {ApplicationError} from '../platform/errors.js';
import {IdempotencyService,OperationEventRepository,type TrustedActorContext} from '../tools/repositories.js';
import type {TodoProjectionService} from '../todos/projection-service.js';
import {isRootActor} from '../access/business-authority.js';
import {requireSampleCapability,canUseSampleCapability} from './sample-authority.js';
import {requireSampleWrites} from './sample-create-service.js';
import {bindSampleAttachments,type SampleAttachmentPurpose} from './sample-attachments.js';
import {sampleInput,sampleWorkflowStateLabel} from './sample-workflow-service.js';
import {sampleSourceHash} from './sample-migration.js';
type Item={sample_id:string;status:string;version:number;holder_user_id:string|null;holder_name:string|null;storage_location:string|null;archived_from_status:string|null;[field:string]:unknown};
type Request={request_id:string;sample_id:string;request_type:string;status:string;from_status:string;requested_by:string;version:number;reason:string;[field:string]:unknown};
const fail=(message:string)=>new ApplicationError('INVALID_STATE_TRANSITION',message,409);
export class SampleDisposalService{
 constructor(private readonly db:Pool,private readonly corporationId:string,private readonly todos:TodoProjectionService,private readonly idempotency=new IdempotencyService(),private readonly events=new OperationEventRepository()){}
 private root(actor:TrustedActorContext){if(!isRootActor(actor))throw new ApplicationError('FORBIDDEN','此操作仅限管理员',403);}
 private async transaction<T>(actor:TrustedActorContext,sampleId:string,version:number,key:string,action:string,input:unknown,work:(client:PoolClient,item:Item)=>Promise<T>){
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效提交编号',400);
  const client=await this.db.connect();try{await client.query('BEGIN');await requireSampleWrites(client);
   const result=await this.idempotency.execute(client,{scope:`sample:${action}`,actorKey:actor.actorId,key,requestHash:sampleSourceHash({sampleId,version,input}),expiresAt:new Date('9999-12-31T00:00:00Z')},async()=>{
    const item=(await client.query<Item>('SELECT * FROM sample_items WHERE sample_id=$1 FOR UPDATE',[sampleId])).rows[0];if(!item)throw new ApplicationError('NOT_FOUND','样衣不存在',404);
    if(item.version!==version)throw new ApplicationError('VERSION_CONFLICT','样衣已更新，请刷新后重试',409);
    return {statusCode:200,response:await work(client,item)};
   });await client.query('COMMIT');return result.response;
  }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
 }
 private async pending(client:PoolClient,id:string){return (await client.query<Request>("SELECT * FROM sample_workflow_requests WHERE sample_id=$1 AND status IN ('pending','payment_pending') FOR UPDATE",[id])).rows[0];}
 private async person(client:PoolClient,id:string){
  const person=(await client.query<{id:string}>(`SELECT u.id FROM app_users u JOIN identity_mappings i ON i.user_id=u.id
   WHERE u.id=$1 AND u.enabled AND i.provider='dingtalk' AND i.corp_id=$2 AND i.active AND i.employed FOR SHARE OF u,i`,[id,this.corporationId])).rows[0];
  if(!person)throw new ApplicationError('VALIDATION_ERROR','责任人必须是当前企业的有效员工',400);return person;
 }
 private async proof(client:PoolClient,actor:TrustedActorContext,sampleId:string,requestId:string,ids:string[],purpose:SampleAttachmentPurpose){
  await bindSampleAttachments(client,actor,sampleId,ids,purpose);
  for(const id of ids)await client.query('INSERT INTO sample_request_attachments(request_id,attachment_id,purpose) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[requestId,id,purpose]);
 }
 private async financeAudit(client:PoolClient,actor:TrustedActorContext,id:string,action:string,summary:Record<string,unknown>,before:unknown,after:Record<string,unknown>,reason?:string){
  const eventId=await this.events.append(client,actor,{action,entityType:'sample',entityId:id,after:summary,...(reason?{reason}:{})});
  await client.query('INSERT INTO sample_financial_audit(event_id,sample_id,before_state,after_state) VALUES($1,$2,$3,$4)',[eventId,id,before,after]);return eventId;
 }
 async project(client:PoolClient,actor:TrustedActorContext,request:Request,eventId:string,sourceAction:string,generation:string){
  const handoff=['borrow','return'].includes(request.request_type),payment=request.status==='payment_pending';
  const capability=handoff?`sample:${request.request_type}_confirm`:payment?'sample:loss_close':'sample:dispose_approve';
  const category=handoff?`sample_${request.request_type}_confirm`:payment?'sample_loss_payment':'sample_disposal_approval';
  if(handoff||payment){
   await this.todos.actionableForAllAssignedRole(client,actor,{category,sourceEventId:eventId,sourceAction,entityType:'sample',entityId:request.sample_id,
    requiredRole:'sample_administrative',requiredCapability:capability,route:{routeName:'sample_detail',entityId:request.sample_id},policyKey:'general',dedupeKey:`sample:${request.request_id}:${category}:${generation}`});return;
  }
  const roles=['owner_group','sample_approver'];
  const recipients=await client.query<{user_id:string;role_code:string}>(`SELECT DISTINCT ON (a.user_id) a.user_id,a.role_code
   FROM user_role_assignments a WHERE a.role_code=ANY($1::text[]) AND a.revoked_at IS NULL
    AND todo_user_has_direct_role(a.user_id,a.role_code,$2) ORDER BY a.user_id,a.role_code`,[roles,capability]);
  if(!recipients.rows.length&&isRootActor(actor))return;
  if(!recipients.rows.length)throw new ApplicationError('CONFLICT','未配置有效的样衣事项处理人；请Root在员工权限页核对样衣审批岗位，再由申请人在本样衣办理页重试；本次未生成待处理申请',409);
  for(const recipient of recipients.rows)await this.todos.actionableForRecipient(client,actor,{category,sourceEventId:eventId,sourceAction,entityType:'sample',entityId:request.sample_id,
   requiredRole:recipient.role_code,requiredCapability:capability,recipientUserId:recipient.user_id,route:{routeName:'sample_detail',entityId:request.sample_id},policyKey:'general',dedupeKey:`sample:${request.request_id}:${category}:${generation}:${recipient.user_id}`});
 }
 async cancelImportedTasks(client:PoolClient,actor:TrustedActorContext,requestId:string){
  await this.todos.cancelOpenByDedupePrefix(client,actor,`sample:${requestId}:`,'迁移按最终源快照重建待办');
  await client.query('UPDATE sample_handoff_challenges SET revoked_at=CURRENT_TIMESTAMP WHERE request_id=$1 AND used_at IS NULL AND revoked_at IS NULL',[requestId]);
 }
 async people(actor:TrustedActorContext,search:string){requireSampleCapability(actor,'sample:dispose_request');
  const rows=await this.db.query(`SELECT u.id AS "userId",u.display_name AS name,COALESCE(array_to_string(p.department_names,' / '),'') AS department
   FROM app_users u JOIN identity_mappings i ON i.user_id=u.id LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
   WHERE u.enabled AND i.provider='dingtalk' AND i.corp_id=$1 AND i.active AND i.employed AND u.display_name ILIKE $2 ORDER BY u.display_name,u.id LIMIT 15`,[this.corporationId,`%${search.replace(/[\\%_]/g,'\\$&')}%`]);return SamplePeopleResponseSchema.parse({people:rows.rows});
 }
 async actions(actor:TrustedActorContext,sampleId:string){
  requireSampleCapability(actor,'sample:view_basic');const item=(await this.db.query<Item>("SELECT * FROM sample_items WHERE sample_id=$1 AND (status<>'archived' OR $2)",[sampleId,isRootActor(actor)])).rows[0];if(!item)throw new ApplicationError('NOT_FOUND','样衣不存在',404);
  const pending=(await this.db.query<{request_id:string;request_type:'sale'|'gift'|'scrap'|'loss';status:string;reason:string;recipient:string|null;responsible_name:string|null;proposed_amount:string|null;final_amount:string|null}>(`SELECT r.request_id,r.request_type,r.status,r.reason,d.recipient,d.responsible_name,d.proposed_amount::text,d.final_amount::text
   FROM sample_workflow_requests r JOIN sample_disposals d USING(request_id) WHERE r.sample_id=$1 AND r.status IN ('pending','payment_pending')`,[sampleId])).rows[0];
  const can=(cap:SampleCapability)=>canUseSampleCapability(actor,cap),canClose=!!pending&&item.status==='loss_payment_pending'&&can('sample:loss_close'),finance=can('sample:view_finance');
  return SampleDisposalActionsSchema.parse({enabled:(await this.db.query<{enabled:boolean}>('SELECT enabled FROM sample_write_control WHERE singleton=true')).rows[0]?.enabled===true,sampleId,version:item.version,status:item.status,
   canRequest:['in_stock','borrowed'].includes(item.status)&&can('sample:dispose_request'),canApprove:item.status==='disposal_pending'&&can('sample:dispose_approve'),canCloseLoss:canClose,
   canUpdateBasic:item.status!=='archived'&&can('sample:update_basic'),canUpdateLocation:item.status==='in_stock'&&can('sample:update_location'),canCorrectFinance:(item.status!=='archived'||isRootActor(actor))&&can('sample:correct_finance'),canReplaceReceipts:isRootActor(actor),canArchive:item.status!=='archived'&&isRootActor(actor),canRestore:item.status==='archived'&&isRootActor(actor),
   pending:pending?{requestId:pending.request_id,type:pending.request_type,status:pending.status,reason:pending.reason,recipient:pending.recipient,responsibleName:pending.responsible_name,
    ...(finance&&pending.proposed_amount!=null?{proposedAmount:pending.proposed_amount}:{}),...((finance||canClose)&&pending.final_amount!=null?{finalAmount:pending.final_amount}:{})}:null});
 }
 async request(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:dispose_request');actor={...actor,authorizationCapability:'sample:dispose_request'};const input=sampleInput(SampleDisposalRequestSchema,raw);
  return this.transaction(actor,id,input.version,key,'dispose-request',input,async(client,item)=>{
   const allowed=input.type==='loss'?['borrowed']:input.type==='scrap'?['borrowed','in_stock']:['in_stock'];if(!allowed.includes(item.status))throw fail(`当前样衣为${sampleWorkflowStateLabel(item.status)}，不能提交本次处置。${input.type==='loss'?'遗失申请仅适用于借出中样衣，请申请人核对持有及交接记录':input.type==='scrap'?'报废仅适用于借出中或在库样衣，请行政先核对当前未结束申请':'出售或赠送前请先由持有人申请归还、行政确认实物入库'}；在本样衣办理页处理，不要重复建档。`);
   const responsible=input.type==='loss'?(await this.person(client,input.responsibleUserId)).id:null;
   const reference=input.type==='loss'?(await client.query<{price:string}>('SELECT purchase_price::text price FROM sample_financial_facts WHERE sample_id=$1',[id])).rows[0]?.price:input.type==='sale'?input.amount:null;
   if(input.type==='loss'&&reference==null)throw fail('采购资料缺失，不能生成赔偿参考；请财务或Root在本样衣财务资料核对采购记录后再办理遗失申请');
   const requestId=randomUUID();const request=(await client.query<Request>(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by,requested_for,reason)
    VALUES($1,$2,$3,'pending',$4,$5,$6,$7) RETURNING *`,[requestId,id,input.type,item.status,actor.actorId,responsible,'reason' in input?input.reason:''])).rows[0]!;
   await client.query(`INSERT INTO sample_disposals(disposal_id,request_id,sample_id,disposal_type,recipient,responsible_user_id,proposed_amount)
    VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),requestId,id,input.type,'recipient' in input?input.recipient:null,responsible,reference]);
   if('proofAttachmentIds' in input)await this.proof(client,actor,id,requestId,input.proofAttachmentIds,'disposal_proof');
   await client.query("UPDATE sample_items SET status='disposal_pending',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[id]);
   const eventId=await this.financeAudit(client,actor,id,'sample.disposal_requested',{requestId,type:input.type,status:'disposal_pending',version:item.version+1,previousStatus:item.status},null,{type:input.type,proposedAmount:reference},'reason' in input?input.reason:undefined);
   await this.project(client,actor,request,eventId,'sample.disposal_requested','request');return {sampleId:id,status:'disposal_pending',version:item.version+1};
  });
 }
 private async endCustody(client:PoolClient,item:Item){
  if(!item.holder_user_id)return;
  const closed=await client.query('UPDATE sample_custody_records SET disposed_at=CURRENT_TIMESTAMP WHERE sample_id=$1 AND holder_user_id=$2 AND returned_at IS NULL AND disposed_at IS NULL',[item.sample_id,item.holder_user_id]);
  if(closed.rowCount!==1)throw fail('持有历史不一致，不能结束处置；请行政提供本样衣链接及交接凭据给Root核查，未改写既有持有记录');
 }
 async decide(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:dispose_approve');actor={...actor,authorizationCapability:'sample:dispose_approve'};const input=sampleInput(SampleDisposalDecisionSchema,raw);
  return this.transaction(actor,id,input.version,key,'dispose-decision',input,async(client,item)=>{
   const request=await this.pending(client,id);if(item.status!=='disposal_pending'||!request||request.status!=='pending')throw fail('该处置申请已处理或已不在待审批状态；请审批人在本样衣办理页重新读取原申请结果，不要重复提交决定');
   if(input.decision==='reject'){
    await client.query("UPDATE sample_workflow_requests SET status='rejected',resolved_by=$2,resolved_at=CURRENT_TIMESTAMP,resolution_reason=$3,version=version+1 WHERE request_id=$1",[request.request_id,actor.actorId,input.reason]);
    await client.query('UPDATE sample_items SET status=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1',[id,request.from_status]);
    await this.events.append(client,actor,{action:'sample.disposal_rejected',entityType:'sample',entityId:id,before:{status:item.status,version:item.version},after:{status:request.from_status,version:item.version+1,requestId:request.request_id},reason:input.reason});
    await this.todos.completeOpenByDedupePrefix(client,actor,`sample:${request.request_id}:`,'处置申请已拒绝');return {sampleId:id,status:request.from_status,version:item.version+1};
   }
   const monetary=['sale','loss'].includes(request.request_type);if(monetary&&!input.finalAmount)throw new ApplicationError('VALIDATION_ERROR','请填写大于零的最终出售或赔偿金额',400);
   if(!monetary&&input.finalAmount!==undefined)throw new ApplicationError('VALIDATION_ERROR','赠送与报废不填写金额',400);
   const financialBefore=(await client.query('SELECT proposed_amount::text AS "proposedAmount",final_amount::text AS "finalAmount" FROM sample_disposals WHERE request_id=$1',[request.request_id])).rows[0];
   const loss=request.request_type==='loss',status=loss?'loss_payment_pending':({sale:'sold',gift:'gifted',scrap:'scrapped'} as Record<string,string>)[request.request_type];if(!status)throw fail('处置类型无效');
   await client.query('UPDATE sample_disposals SET approved_by=$2,approved_at=CURRENT_TIMESTAMP,final_amount=$3 WHERE request_id=$1',[request.request_id,actor.actorId,input.finalAmount??null]);
   if(loss){await client.query("UPDATE sample_workflow_requests SET status='payment_pending',version=version+1 WHERE request_id=$1",[request.request_id]);await client.query("UPDATE sample_items SET status='loss_payment_pending',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[id]);}
   else{await this.endCustody(client,item);await client.query("UPDATE sample_workflow_requests SET status='completed',resolved_by=$2,resolved_at=CURRENT_TIMESTAMP,version=version+1 WHERE request_id=$1",[request.request_id,actor.actorId]);
    await client.query('UPDATE sample_items SET status=$2,holder_user_id=NULL,holder_name=NULL,purpose=NULL,borrowed_at=NULL,storage_location=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1',[id,status]);}
   const eventId=await this.financeAudit(client,actor,id,'sample.disposal_approved',{requestId:request.request_id,type:request.request_type,status,version:item.version+1,previousStatus:item.status},financialBefore,{type:request.request_type,finalAmount:input.finalAmount??null},input.reason);
   await this.todos.completeOpenByDedupePrefix(client,actor,`sample:${request.request_id}:`,'处置审批已完成');
   if(loss)await this.project(client,actor,{...request,status:'payment_pending'},eventId,'sample.disposal_approved','approved');return {sampleId:id,status,version:item.version+1};
  });
 }
 async closeLoss(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:loss_close');actor={...actor,authorizationCapability:'sample:loss_close'};const input=sampleInput(SampleLossCloseSchema,raw);
  return this.transaction(actor,id,input.version,key,'loss-close',input,async(client,item)=>{
   const request=await this.pending(client,id);if(item.status!=='loss_payment_pending'||request?.status!=='payment_pending'||request.request_type!=='loss')throw fail('只有审批后的遗失待赔付事项可以结案；请行政在本样衣办理页查看原处置决定，取得实际赔付凭据后再登记结案');
   await this.proof(client,actor,id,request.request_id,input.proofAttachmentIds,'payment_proof');await this.endCustody(client,item);
   const disposal=(await client.query<{final_amount:string}>('UPDATE sample_disposals SET paid_by=$2,paid_at=CURRENT_TIMESTAMP WHERE request_id=$1 RETURNING final_amount::text',[request.request_id,actor.actorId])).rows[0]!;
   await client.query("UPDATE sample_workflow_requests SET status='completed',resolved_by=$2,resolved_at=CURRENT_TIMESTAMP,version=version+1 WHERE request_id=$1",[request.request_id,actor.actorId]);
   await client.query("UPDATE sample_items SET status='lost',holder_user_id=NULL,holder_name=NULL,purpose=NULL,borrowed_at=NULL,storage_location=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[id]);
   await this.financeAudit(client,actor,id,'sample.loss_closed',{requestId:request.request_id,status:'lost',version:item.version+1,previousStatus:item.status},null,{finalAmount:disposal.final_amount,paymentAttachmentIds:input.proofAttachmentIds});
   await this.todos.completeOpenByDedupePrefix(client,actor,`sample:${request.request_id}:`,'遗失赔付已确认结案');return {sampleId:id,status:'lost',version:item.version+1};
  });
 }
 async updateBasic(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:update_basic');actor={...actor,authorizationCapability:'sample:update_basic'};const input=sampleInput(SampleBasicUpdateSchema,raw);
  return this.transaction(actor,id,input.version,key,'basic-update',input,async(client,item)=>{
   if(item.status==='archived')throw fail('请先恢复样衣再修改资料');
   const before={brand:item.brand,styleName:item.style_name,color:item.color,department:item.department,styleNo:item.style_no,category:item.category,size:item.size,remark:item.remark};
   await client.query('UPDATE sample_items SET brand=$2,style_name=$3,color=$4,department=$5,style_no=$6,category=$7,size=$8,remark=$9,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1',[id,input.brand,input.styleName,input.color,input.department,input.styleNo,input.category,input.size,input.remark]);
   const after={brand:input.brand,styleName:input.styleName,color:input.color,department:input.department,styleNo:input.styleNo,category:input.category,size:input.size,remark:input.remark};const reason=input.reason;await this.events.append(client,actor,{action:'sample.basic_updated',entityType:'sample',entityId:id,before,after,reason});return {sampleId:id,status:item.status,version:item.version+1};
  });
 }
 async updateLocation(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:update_location');actor={...actor,authorizationCapability:'sample:update_location'};const input=sampleInput(SampleLocationUpdateSchema,raw);
  return this.transaction(actor,id,input.version,key,'location-update',input,async(client,item)=>{if(item.status!=='in_stock')throw fail('仅在库样衣可以修改存放位置');
   await client.query('UPDATE sample_items SET storage_location=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1',[id,input.storageLocation]);
   await this.events.append(client,actor,{action:'sample.location_updated',entityType:'sample',entityId:id,before:{storageLocation:item.storage_location},after:{storageLocation:input.storageLocation},reason:input.reason});return {sampleId:id,status:item.status,version:item.version+1};});
 }
 async correctFinance(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:correct_finance');actor={...actor,authorizationCapability:'sample:correct_finance'};const input=sampleInput(SampleFinanceCorrectionSchema,raw);
  if(input.receiptMode==='replace'&&!isRootActor(actor))throw new ApplicationError('FORBIDDEN','财务只能追加小票，不能撤下原小票',403);
  return this.transaction(actor,id,input.version,key,'finance-correct',input,async(client,item)=>{
   if(item.status==='archived'&&!isRootActor(actor))throw fail('请先由管理员恢复样衣再修改资料');
   const before=(await client.query<{purchasePrice:string}>('SELECT purchase_price::text AS "purchasePrice" FROM sample_financial_facts WHERE sample_id=$1 FOR UPDATE',[id])).rows[0];if(!before)throw fail('采购资料不存在');
   const old=(await client.query<{attachment_id:string}>('SELECT attachment_id FROM sample_attachment_bindings WHERE sample_id=$1 AND purpose=\'purchase_receipt\' AND active',[id])).rows.map(row=>row.attachment_id);
   const existing=(await client.query<{attachment_id:string}>('SELECT attachment_id FROM sample_attachment_bindings WHERE sample_id=$1 AND purpose=\'purchase_receipt\'',[id])).rows.map(row=>row.attachment_id);
   const valid=await client.query("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready' AND mime_type LIKE 'image/%' ORDER BY attachment_id FOR UPDATE",[input.receiptAttachmentIds]);
   if(valid.rows.length!==input.receiptAttachmentIds.length)throw new ApplicationError('VALIDATION_ERROR','小票必须是有效的已完成上传图片',400);
   await bindSampleAttachments(client,actor,id,input.receiptAttachmentIds.filter(file=>!existing.includes(file)),'purchase_receipt');
   const receiptIds=input.receiptMode==='append'?[...new Set([...old,...input.receiptAttachmentIds])]:input.receiptAttachmentIds;
   if(input.receiptMode==='replace'&&!receiptIds.length)throw new ApplicationError('VALIDATION_ERROR','更正后至少保留一张有效小票',400);
   await client.query("UPDATE sample_attachment_bindings SET active=(attachment_id=ANY($2::uuid[])) WHERE sample_id=$1 AND purpose='purchase_receipt'",[id,receiptIds]);
   await client.query('UPDATE sample_financial_facts SET purchase_price=$2,version=version+1 WHERE sample_id=$1',[id,input.purchasePrice]);
   await client.query('UPDATE sample_items SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1',[id]);
   await this.financeAudit(client,actor,id,'sample.finance_corrected',{version:item.version+1,receiptCount:receiptIds.length},{...before,receiptAttachmentIds:old},{purchasePrice:input.purchasePrice,receiptAttachmentIds:receiptIds},input.reason);
   return {sampleId:id,status:item.status,version:item.version+1};
  });
 }
 async archive(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  this.root(actor);actor={...actor,authorizationCapability:'sample:archive'};const input=sampleInput(SampleArchiveSchema,raw);
  return this.transaction(actor,id,input.version,key,'archive',input,async(client,item)=>{
   if(item.status==='archived')throw fail('样衣已经归档');const request=await this.pending(client,id);
   if(request){await client.query("UPDATE sample_workflow_requests SET status='cancelled',resolved_by=$2,resolved_at=CURRENT_TIMESTAMP,resolution_reason='样衣归档',version=version+1 WHERE request_id=$1",[request.request_id,actor.actorId]);
    await this.todos.cancelOpenByDedupePrefix(client,actor,`sample:${request.request_id}:`,'样衣已归档');await client.query('UPDATE sample_handoff_challenges SET revoked_at=CURRENT_TIMESTAMP WHERE request_id=$1 AND used_at IS NULL AND revoked_at IS NULL',[request.request_id]);}
   await client.query("UPDATE sample_items SET status='archived',archived_from_status=$2,archived_reason=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[id,item.status,input.reason]);
   const eventId=await this.events.append(client,actor,{action:'sample.archived',entityType:'sample',entityId:id,before:{status:item.status,version:item.version},after:{status:'archived',version:item.version+1},reason:input.reason});
   await client.query('INSERT INTO sample_archive_records(event_id,sample_id,item_snapshot,request_snapshot) VALUES($1,$2,$3,$4)',[eventId,id,item,request??null]);return {sampleId:id,status:'archived',version:item.version+1};
  });
 }
 async restore(actor:TrustedActorContext,id:string,raw:unknown,key:string){
  this.root(actor);actor={...actor,authorizationCapability:'sample:archive'};const input=sampleInput(SampleArchiveSchema,raw);
  return this.transaction(actor,id,input.version,key,'restore',input,async(client,item)=>{
   if(item.status!=='archived'||!item.archived_from_status)throw fail('样衣未归档');
   const archived=(await client.query<{request_snapshot:Request|null}>('SELECT request_snapshot FROM sample_archive_records WHERE sample_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1',[id])).rows[0];
   if(!archived)throw fail('缺少归档快照，当前无法恢复样衣；请Root核对本样衣归档及迁移记录，不能凭当前页面猜测历史状态');
   const request=archived.request_snapshot;
   if(request){const restored=await client.query("UPDATE sample_workflow_requests SET status=$2,resolved_by=NULL,resolved_at=NULL,resolution_reason=NULL,version=version+1 WHERE request_id=$1 AND status='cancelled' AND resolution_reason='样衣归档' AND version=$3",[request.request_id,request.status,request.version+1]);if(restored.rowCount!==1)throw fail('归档期间申请发生变化，不能直接恢复');}
   await client.query('UPDATE sample_items SET status=archived_from_status,archived_from_status=NULL,archived_reason=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1',[id]);
   const eventId=await this.events.append(client,actor,{action:'sample.restored',entityType:'sample',entityId:id,before:{status:'archived',version:item.version},after:{status:item.archived_from_status,version:item.version+1},reason:input.reason});
   if(request)await this.project(client,actor,request,eventId,'sample.restored',eventId);return {sampleId:id,status:item.archived_from_status,version:item.version+1};
  });
 }
 async archived(actor:TrustedActorContext,page:number){
  this.root(actor);if(!Number.isInteger(page)||page<1||page>100000)throw new ApplicationError('VALIDATION_ERROR','页码无效',400);
  const rows=await this.db.query('SELECT sample_id AS "sampleId",sample_code AS "sampleCode",style_name AS "styleName",archived_from_status AS "previousStatus",archived_reason AS reason,version FROM sample_items WHERE status=\'archived\' ORDER BY updated_at DESC,sample_id DESC LIMIT 15 OFFSET $1',[(page-1)*15]);
  const count=await this.db.query("SELECT count(*)::int total FROM sample_items WHERE status='archived'");return {page,totalCount:count.rows[0].total,items:rows.rows};
 }
 async financialHistory(actor:TrustedActorContext,id:string,page:number){
  requireSampleCapability(actor,'sample:view_finance');if(!Number.isInteger(page)||page<1||page>100000)throw new ApplicationError('VALIDATION_ERROR','页码无效',400);
  const exists=await this.db.query("SELECT 1 FROM sample_items WHERE sample_id=$1 AND (status<>'archived' OR $2)",[id,isRootActor(actor)]);if(!exists.rows.length)throw new ApplicationError('NOT_FOUND','样衣不存在',404);
  const result=await this.db.query(`SELECT f.event_id AS "eventId",e.action,s.actor_name AS "actorName",f.created_at::text AS "occurredAt",e.reason,f.before_state AS before,f.after_state AS after
   FROM sample_financial_audit f JOIN operation_events e USING(event_id) JOIN sample_event_actor_snapshots s USING(event_id)
   WHERE f.sample_id=$1 ORDER BY f.created_at DESC,f.event_id DESC LIMIT 15 OFFSET $2`,[id,(page-1)*15]);
  const count=await this.db.query('SELECT count(*)::int total FROM sample_financial_audit WHERE sample_id=$1',[id]);return SampleFinancialAuditResponseSchema.parse({page,totalCount:count.rows[0].total,items:result.rows});
 }
}
