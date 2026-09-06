import { createHash,randomBytes,randomUUID } from "node:crypto";
import type { Pool,PoolClient } from "pg";
import type { z } from "zod";
import QRCode from "qrcode";
import { SampleBorrowRequestSchema,SampleReturnRequestSchema,SampleConfirmSchema,SampleCancelSchema,SampleVersionSchema,SampleReturnBatchSchema,SampleWorkflowViewSchema,SamplePeopleResponseSchema,type SampleCapability } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService,OperationEventRepository,type TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { isRootActor } from "../access/business-authority.js";
import { requireSampleCapability,canUseSampleCapability } from "./sample-authority.js";
import { requireSampleWrites } from "./sample-create-service.js";
import { bindSampleAttachments } from "./sample-attachments.js";
import { sampleSourceHash } from "./sample-migration.js";

type Item = {sample_id:string;status:string;version:number;holder_user_id:string|null;holder_name:string|null;department:string;storage_location:string|null;purpose:string|null;borrowed_at:Date|null};
type Request = {request_id:string;sample_id:string;request_type:string;status:string;from_status:string;requested_by:string;requested_by_name:string;requested_for:string|null;requested_for_name:string|null;department:string;purpose:string|null;reason:string;version:number};
const fail = (message:string) => new ApplicationError("INVALID_STATE_TRANSITION",message,409);
export function sampleInput<T>(schema:z.ZodType<T>,input:unknown):T {
 const parsed=schema.safeParse(input);if(!parsed.success)throw new ApplicationError("VALIDATION_ERROR","请完整填写当前操作所需资料",400);return parsed.data;
}
export class SampleWorkflowService {
 constructor(private readonly db:Pool,private readonly corporationId:string,private readonly publicBaseUrl:string,
  private readonly todos:TodoProjectionService,private readonly idempotency=new IdempotencyService(),private readonly events=new OperationEventRepository(),
  private readonly encodeQr:(text:string)=>Promise<string>=text=>QRCode.toString(text,{type:'svg',errorCorrectionLevel:'M',margin:2})){}

 private async item(client:PoolClient,id:string):Promise<Item>{
  const row=(await client.query<Item>("SELECT * FROM sample_items WHERE sample_id=$1 FOR UPDATE",[id])).rows[0];
  if(!row)throw new ApplicationError("NOT_FOUND","样衣不存在",404);return row;
 }
 private async pending(client:PoolClient,id:string):Promise<Request>{
  const row=(await client.query<Request>("SELECT * FROM sample_workflow_requests WHERE sample_id=$1 AND status IN ('pending','payment_pending') FOR UPDATE",[id])).rows[0];
  if(!row)throw fail("该申请已处理，请刷新");return row;
 }
 private async person(client:PoolClient,id:string){
  const row=(await client.query<{id:string;display_name:string}>(`SELECT u.id,u.display_name FROM app_users u JOIN identity_mappings i ON i.user_id=u.id
   WHERE u.id=$1 AND u.enabled AND i.provider='dingtalk' AND i.corp_id=$2 AND i.active AND i.employed FOR SHARE OF u,i`,[id,this.corporationId])).rows[0];
  if(!row)throw new ApplicationError("VALIDATION_ERROR","员工已停用、离职或不属于当前企业",400);return row;
 }
 private async transaction<T>(actor:TrustedActorContext,id:string,version:number,key:string,action:string,input:unknown,work:(client:PoolClient,item:Item)=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key))throw new ApplicationError("VALIDATION_ERROR","缺少有效提交编号",400);
  const client=await this.db.connect();try{
   await client.query("BEGIN");await requireSampleWrites(client);
   const result=await this.idempotency.execute(client,{scope:`sample:${action}`,actorKey:actor.actorId,key,requestHash:sampleSourceHash({id,version,input}),expiresAt:new Date("9999-12-31T00:00:00Z")},async()=>{
    const item=await this.item(client,id);if(item.version!==version)throw new ApplicationError("VERSION_CONFLICT","样衣已被其他人更新，请刷新后重试",409);
    return {statusCode:200,response:await work(client,item)};
   });await client.query("COMMIT");return result.response;
  }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
 }
 private async notify(client:PoolClient,actor:TrustedActorContext,requestId:string,sampleId:string,type:"borrow"|"return",eventId:string){
  await this.todos.actionableForAllAssignedRole(client,actor,{category:`sample_${type}_confirm`,sourceEventId:eventId,sourceAction:`sample.${type}_requested`,entityType:"sample",entityId:sampleId,
   requiredRole:"sample_administrative",requiredCapability:`sample:${type}_confirm`,route:{routeName:"sample_detail",entityId:sampleId},policyKey:"general",dedupeKey:`sample:${requestId}:confirm`});
 }
 async people(actor:TrustedActorContext,search:string){
  requireSampleCapability(actor,'sample:borrow_request');
  const result=await this.db.query(`SELECT u.id AS "userId",u.display_name AS name,COALESCE(array_to_string(p.department_names,' / '),'') AS department
   FROM app_users u JOIN identity_mappings i ON i.user_id=u.id LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
   WHERE u.enabled AND i.provider='dingtalk' AND i.corp_id=$1 AND i.active AND i.employed AND u.display_name ILIKE $2
   ORDER BY u.display_name,u.id LIMIT 15`,[this.corporationId,`%${search.replace(/[\\%_]/g,'\\$&')}%`]);
  return SamplePeopleResponseSchema.parse({people:result.rows});
 }
 async view(actor:TrustedActorContext,sampleId:string){
  requireSampleCapability(actor,"sample:view_basic");
  const item=(await this.db.query<Item>("SELECT * FROM sample_items WHERE sample_id=$1 AND (status<>'archived' OR $2)",[sampleId,isRootActor(actor)])).rows[0];
  if(!item)throw new ApplicationError("NOT_FOUND","样衣不存在",404);
  const request=(await this.db.query<Request>("SELECT * FROM sample_workflow_requests WHERE sample_id=$1 AND status IN ('pending','payment_pending')",[sampleId])).rows[0];
  const enabled=(await this.db.query<{enabled:boolean}>("SELECT enabled FROM sample_write_control WHERE singleton=true")).rows[0]?.enabled===true;
  const handoff=request?.status==='pending'&&['borrow','return'].includes(request.request_type);
  return SampleWorkflowViewSchema.parse({enabled,sampleId,version:item.version,status:item.status,
   canBorrow:item.status==='in_stock'&&canUseSampleCapability(actor,'sample:borrow_request'),
   canReturn:item.status==='borrowed'&&canUseSampleCapability(actor,'sample:return_request')&&(item.holder_user_id===actor.actorId||isRootActor(actor)),
   canConfirm:!!handoff&&canUseSampleCapability(actor,`sample:${request!.request_type}_confirm` as SampleCapability),
   canCancel:request?.status==='pending'&&(request.requested_by===actor.actorId||isRootActor(actor)||canUseSampleCapability(actor,'sample:borrow_confirm'))||false,
   canIssueQr:!!handoff&&(request!.requested_by===actor.actorId||isRootActor(actor)),
   request:request?{requestId:request.request_id,type:request.request_type,requesterName:request.requested_by_name,borrowerName:request.requested_for_name,purpose:request.purpose,reason:request.reason}:null});
 }
 async borrow(actor:TrustedActorContext,sampleId:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:borrow_request');actor={...actor,authorizationCapability:'sample:borrow_request'};const input=sampleInput(SampleBorrowRequestSchema,raw);
  return this.transaction(actor,sampleId,input.version,key,'borrow-request',input,async(client,item)=>{
   if(item.status!=='in_stock')throw fail('仅在库样衣可以申请借出');
   const borrower=await this.person(client,input.borrowerUserId??actor.actorId),requestId=randomUUID();
   await client.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by,requested_for,purpose)
    VALUES($1,$2,'borrow','pending','in_stock',$3,$4,$5)`,[requestId,sampleId,actor.actorId,borrower.id,input.purpose]);
   await client.query("UPDATE sample_items SET status='borrow_pending',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[sampleId]);
   const eventId=await this.events.append(client,actor,{action:'sample.borrow_requested',entityType:'sample',entityId:sampleId,before:{status:item.status,version:item.version},after:{status:'borrow_pending',version:item.version+1,requestId,borrowerUserId:borrower.id,requestedBy:actor.actorId,delegated:borrower.id!==actor.actorId,purpose:input.purpose}});
   await this.notify(client,actor,requestId,sampleId,'borrow',eventId);return {sampleId,requestId,status:'borrow_pending',version:item.version+1};
  });
 }
 async returnRequest(actor:TrustedActorContext,sampleId:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:return_request');actor={...actor,authorizationCapability:'sample:return_request'};const input=sampleInput(SampleReturnRequestSchema,raw);
  return this.transaction(actor,sampleId,input.version,key,'return-request',input,async(client,item)=>{
   if(item.status!=='borrowed')throw fail('仅借出中的样衣可以申请归还');
   if(item.holder_user_id!==actor.actorId&&!isRootActor(actor))throw new ApplicationError('FORBIDDEN','仅当前持有人可以申请归还',403);
   const requestId=randomUUID();
   await client.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by,requested_for)
    VALUES($1,$2,'return','pending','borrowed',$3,$4)`,[requestId,sampleId,actor.actorId,item.holder_user_id]);
   await bindSampleAttachments(client,actor,sampleId,input.photoAttachmentIds,'return_photo');
   for(const id of input.photoAttachmentIds)await client.query("INSERT INTO sample_request_attachments(request_id,attachment_id,purpose) VALUES($1,$2,'return_photo')",[requestId,id]);
   await client.query("UPDATE sample_items SET status='return_pending',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[sampleId]);
   const eventId=await this.events.append(client,actor,{action:'sample.return_requested',entityType:'sample',entityId:sampleId,before:{status:item.status,version:item.version,holderUserId:item.holder_user_id},after:{status:'return_pending',version:item.version+1,requestId,photoAttachmentIds:input.photoAttachmentIds}});
   await this.notify(client,actor,requestId,sampleId,'return',eventId);return {sampleId,requestId,status:'return_pending',version:item.version+1};
  });
 }
 async returnBatch(actor:TrustedActorContext,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:return_request');const input=sampleInput(SampleReturnBatchSchema,raw);
  if(!/^[A-Za-z0-9._:-]{8,80}$/.test(key))throw new ApplicationError('VALIDATION_ERROR','缺少有效提交编号',400);
  const items=[];for(const entry of input.items){const {sampleId,...data}=entry;try{items.push({sampleId,success:true as const,result:await this.returnRequest(actor,sampleId,data,`${key}:${sampleId}`)});}
   catch(error){if(!(error instanceof ApplicationError))throw error;items.push({sampleId,success:false as const,message:error.message});}}
  return {items};
 }
 async issueQr(actor:TrustedActorContext,sampleId:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:view_basic');const input=sampleInput(SampleVersionSchema,raw);
  return this.transaction(actor,sampleId,input.version,key,'handoff-qr',input,async(client)=>{
   const request=await this.pending(client,sampleId);
   if(request.status!=='pending'||!['borrow','return'].includes(request.request_type))throw fail('该申请不需要实物交接确认');
   if(request.requested_by!==actor.actorId&&!isRootActor(actor))throw new ApplicationError('FORBIDDEN','只能展示本人申请的交接码',403);
   await this.person(client,request.requested_by);
   const token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(token).digest('hex');
   await client.query("UPDATE sample_handoff_challenges SET revoked_at=CURRENT_TIMESTAMP WHERE request_id=$1 AND used_at IS NULL AND revoked_at IS NULL",[request.request_id]);
   const challenge=(await client.query<{expires_at:Date}>(`INSERT INTO sample_handoff_challenges(token_hash,request_id,subject_user_id,issued_by,expires_at)
    VALUES($1,$2,$3,$4,CURRENT_TIMESTAMP+INTERVAL '5 minutes') RETURNING expires_at`,[tokenHash,request.request_id,request.requested_by,actor.actorId])).rows[0]!;
   let base:URL;try{base=new URL(this.publicBaseUrl);}catch{throw new ApplicationError('VALIDATION_ERROR','尚未配置样衣交接入口',500);}
   if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash)throw new ApplicationError('VALIDATION_ERROR','样衣交接入口必须配置有效 HTTPS 地址',500);
   if(!base.pathname.endsWith('/'))base.pathname+='/';const link=new URL('ui/samples/handoff',base);link.hash=token;
   const svg=await this.encodeQr(link.toString());
   await this.events.append(client,actor,{action:'sample.handoff_qr_issued',entityType:'sample',entityId:sampleId,after:{requestId:request.request_id,subjectUserId:request.requested_by,expiresAt:challenge.expires_at.toISOString()}});
   return {svg,expiresAt:challenge.expires_at.toISOString(),requestId:request.request_id,sampleId};
  });
 }
 async lookupQr(actor:TrustedActorContext,token:string){
  requireSampleCapability(actor,'sample:view_basic');if(!/^[A-Za-z0-9_-]{43}$/.test(token))throw new ApplicationError('VALIDATION_ERROR','交接码无效',400);
  const result=(await this.db.query<Request&{item_version:number}>(`SELECT r.*,s.version item_version FROM sample_handoff_challenges q
   JOIN sample_workflow_requests r USING(request_id) JOIN sample_items s USING(sample_id)
   WHERE q.token_hash=$1 AND q.expires_at>CURRENT_TIMESTAMP AND q.used_at IS NULL AND q.revoked_at IS NULL
   AND r.status='pending' AND q.subject_user_id=r.requested_by`,[createHash('sha256').update(token).digest('hex')])).rows[0];
  if(!result||!['borrow','return'].includes(result.request_type))throw fail('交接码已失效，请让申请人重新生成');
  requireSampleCapability(actor,`sample:${result.request_type}_confirm` as SampleCapability);
  return {sampleId:result.sample_id,requestId:result.request_id,requesterName:result.requested_by_name,type:result.request_type,version:result.item_version};
 }
 async confirm(actor:TrustedActorContext,sampleId:string,raw:unknown,key:string){
  if(!canUseSampleCapability(actor,'sample:borrow_confirm')&&!canUseSampleCapability(actor,'sample:return_confirm'))throw new ApplicationError('FORBIDDEN','当前身份无权确认样衣交接',403);
  const input=sampleInput(SampleConfirmSchema,raw);
  return this.transaction(actor,sampleId,input.version,key,'handoff-confirm',input,async(client,item)=>{
   const request=await this.pending(client,sampleId);
   if(request.status!=='pending'||!['borrow','return'].includes(request.request_type)||item.status!==`${request.request_type}_pending`)throw fail('申请状态已变化');
   requireSampleCapability(actor,`sample:${request.request_type}_confirm` as SampleCapability);
   actor={...actor,authorizationCapability:`sample:${request.request_type}_confirm`};
   const q=(await client.query<{subject_user_id:string}>(`SELECT subject_user_id FROM sample_handoff_challenges WHERE token_hash=$1 AND request_id=$2
    AND expires_at>CURRENT_TIMESTAMP AND used_at IS NULL AND revoked_at IS NULL FOR UPDATE`,[createHash('sha256').update(input.token).digest('hex'),request.request_id])).rows[0];
   if(!q||q.subject_user_id!==request.requested_by)throw fail('交接码不匹配、过期或已使用');
   await this.person(client,q.subject_user_id);
   const borrowing=request.request_type==='borrow',status=borrowing?'borrowed':'in_stock';
   if(borrowing){
    if(!request.requested_for||!request.purpose)throw fail('借用资料不完整');await this.person(client,request.requested_for);
    await client.query(`INSERT INTO sample_custody_records(custody_id,sample_id,holder_user_id,holder_name,department,purpose,borrowed_at,requested_by,confirmed_by)
     VALUES($1,$2,$3,$4,$5,$6,CURRENT_TIMESTAMP,$7,$8)`,[randomUUID(),sampleId,request.requested_for,request.requested_for_name,request.department,request.purpose,request.requested_by,actor.actorId]);
    await client.query(`UPDATE sample_items SET status='borrowed',holder_user_id=$2,holder_name=$3,purpose=$4,borrowed_at=CURRENT_TIMESTAMP,storage_location=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1`,[sampleId,request.requested_for,request.requested_for_name,request.purpose]);
   }else{
    if(!input.storageLocation)throw new ApplicationError('VALIDATION_ERROR','收到实物后必须填写在库位置',400);
    const closed=await client.query("UPDATE sample_custody_records SET returned_at=CURRENT_TIMESTAMP WHERE sample_id=$1 AND holder_user_id=$2 AND returned_at IS NULL",[sampleId,item.holder_user_id]);
    if(closed.rowCount!==1)throw fail('当前持有记录不一致，请联系管理员核对');
    await client.query(`UPDATE sample_items SET status='in_stock',holder_user_id=NULL,holder_name=NULL,purpose=NULL,borrowed_at=NULL,storage_location=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1`,[sampleId,input.storageLocation]);
   }
   await client.query("UPDATE sample_workflow_requests SET status='completed',resolved_by=$2,resolved_at=CURRENT_TIMESTAMP,version=version+1 WHERE request_id=$1",[request.request_id,actor.actorId]);
   await client.query("UPDATE sample_handoff_challenges SET used_at=CURRENT_TIMESTAMP,used_by=$2 WHERE token_hash=$1",[createHash('sha256').update(input.token).digest('hex'),actor.actorId]);
   await this.events.append(client,actor,{action:`sample.${request.request_type}_confirmed`,entityType:'sample',entityId:sampleId,before:{status:item.status,version:item.version,holderUserId:item.holder_user_id,storageLocation:item.storage_location},after:{status,version:item.version+1,requestId:request.request_id,holderUserId:borrowing?request.requested_for:null,storageLocation:borrowing?null:input.storageLocation,scannedUserId:q.subject_user_id}});
   await this.todos.completeOpenByDedupePrefix(client,actor,`sample:${request.request_id}:`,'样衣实物交接已完成');return {sampleId,requestId:request.request_id,status,version:item.version+1};
  });
 }
 async cancel(actor:TrustedActorContext,sampleId:string,raw:unknown,key:string){
  requireSampleCapability(actor,'sample:view_basic');const input=sampleInput(SampleCancelSchema,raw);
  return this.transaction(actor,sampleId,input.version,key,'cancel',input,async(client,item)=>{
   const request=await this.pending(client,sampleId);if(request.status!=='pending')throw fail('已审批事项不能撤销');
   if(request.requested_by!==actor.actorId&&!isRootActor(actor)&&!canUseSampleCapability(actor,'sample:borrow_confirm'))throw new ApplicationError('FORBIDDEN','仅发起人、行政或管理员可以撤销',403);
   await client.query("UPDATE sample_workflow_requests SET status='cancelled',resolved_by=$2,resolved_at=CURRENT_TIMESTAMP,resolution_reason=$3,version=version+1 WHERE request_id=$1",[request.request_id,actor.actorId,input.reason]);
   await client.query("UPDATE sample_items SET status=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE sample_id=$1",[sampleId,request.from_status]);
   await client.query("UPDATE sample_handoff_challenges SET revoked_at=CURRENT_TIMESTAMP WHERE request_id=$1 AND used_at IS NULL AND revoked_at IS NULL",[request.request_id]);
   await this.events.append(client,actor,{action:'sample.request_cancelled',entityType:'sample',entityId:sampleId,before:{status:item.status,version:item.version},after:{status:request.from_status,version:item.version+1,requestId:request.request_id},reason:input.reason});
   await this.todos.cancelOpenByDedupePrefix(client,actor,`sample:${request.request_id}:`,'样衣申请已撤销');return {sampleId,requestId:request.request_id,status:request.from_status,version:item.version+1};
  });
 }
}
