import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SampleImportPlanSchema,SampleCutoverSchema,type SampleImportPlan,type SampleImportItem} from '@dx-rework/contracts';
import {ApplicationError} from '../platform/errors.js';
import {isRootActor} from '../access/business-authority.js';
import {OperationEventRepository,type TrustedActorContext} from '../tools/repositories.js';
import {inventorySampleSource,sampleSourceHash,sampleMoneyCents,sampleMoneyText,stageSampleSource,type SampleSourceSnapshot} from './sample-migration.js';
import {sampleInput} from './sample-workflow-service.js';
import {bindSampleAttachments,type SampleAttachmentPurpose} from './sample-attachments.js';
import type {SampleDisposalService} from './sample-disposal-service.js';
const invalid=(message:string)=>new ApplicationError('VALIDATION_ERROR',message,400);
const conflict=(message:string)=>new ApplicationError('CONFLICT',message,409);
const issueKey=(issue:{entityType:string;legacyId:string;code:string;field?:string|undefined})=>JSON.stringify([issue.entityType,issue.legacyId,issue.code,issue.field??'']);
const states:Record<string,string>={BORROWED:'borrowed',IN_STOCK:'in_stock',PENDING_BORROW:'borrow_pending',PENDING_RETURN:'return_pending',PENDING_DISPOSAL:'disposal_pending',SOLD:'sold',GIFTED:'gifted',SCRAPPED:'scrapped',LOST:'lost',LOSS_PAYMENT_PENDING:'loss_payment_pending',ARCHIVED:'archived'};
export function validateSampleImport(sourceInput:unknown,rawPlan:unknown){
 const {source,report}=inventorySampleSource(sourceInput),plan=sampleInput(SampleImportPlanSchema,rawPlan);
 if(plan.sourceHash!==report.sourceHash)throw conflict('源快照已改变，请重新盘点并生成映射');
 if(plan.items.length!==source.samples.length||new Set(plan.items.map(i=>i.legacyId)).size!==plan.items.length)throw invalid('必须逐一映射全部源样衣，不能重复或漏项');
 const decisions=new Set(plan.decisions.map(issueKey));if(decisions.size!==plan.decisions.length)throw invalid('异常结论重复');
 for(const issue of report.issues)if(!decisions.has(issueKey(issue)))throw invalid(`迁移异常缺少明确结论：${issue.code}`);
 if(!report.amountComplete)throw invalid('源采购金额无效，禁止猜测或截断后导入');
 const objects=new Map(plan.objects.map(o=>[o.objectKey,o]));if(objects.size!==plan.objects.length||objects.size!==report.attachments.length)throw invalid('附件映射必须完整且唯一');
 for(const object of report.attachments)if(!objects.has(object.objectKey))throw invalid('存在未校验或未转存的源附件');
 for(const item of plan.items){
  const original=source.samples.find(s=>s.id===item.legacyId);if(!original||sampleSourceHash(original)!==item.sourceHash)throw conflict('样衣原记录哈希不符');
  if(original.status==='DISPOSED'){if(!['sold','gifted','scrapped','lost'].includes(item.status))throw invalid('DISPOSED 必须明确归一到具体处置类型');}
  else if(states[String(original.status)]!==item.status)throw invalid('源状态与显式迁移状态不一致');
  for(const field of ['sampleCode','brand','styleName','color','department','purchaser'])if(typeof original[field]!=='string'||!String(original[field]).trim())throw invalid(`源必填字段缺失：${field}`);
  if(typeof original.purchaseDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(original.purchaseDate)||Number.isNaN(Date.parse(original.purchaseDate)))throw invalid('源采购日期无效');
  const history=original.borrowHistory;if(!Array.isArray(history)||history.length!==item.custody.length)throw invalid('借用历史必须逐条保留并映射');
  if(new Set(item.custody.map(h=>h.legacyId)).size!==item.custody.length||new Set(item.requests.map(r=>r.legacyId)).size!==item.requests.length)throw invalid('历史标识不能重复');
  for(let n=0;n<history.length;n++){const h=history[n] as Record<string,unknown>,mapped=item.custody[n]!;if(sampleSourceHash(h)!==mapped.sourceHash||String(h.id??`history-${n}`)!==mapped.legacyId)throw invalid('历史映射哈希或标识不符');if(h.borrower!==mapped.holderName)throw invalid('历史姓名快照必须保留源值');
   if(mapped.requestedBy===null&&!decisions.has(issueKey({entityType:'sample',legacyId:item.legacyId,code:'HISTORICAL_ACTOR_UNVERIFIABLE',field:`borrowHistory[${n}].requestedBy`})))throw invalid('历史申请人不明必须保留未知并填写异常结论，不能冒认操作者');
   const originalBorrowed=h.borrowedAt??h.confirmedAt??h.requestedAt;
   if(typeof originalBorrowed!=='string'||Date.parse(originalBorrowed)!==Date.parse(mapped.borrowedAt))throw invalid('借用时间必须保留原始事实');
   if((h.returnedAt?Date.parse(String(h.returnedAt)):null)!==(mapped.returnedAt?Date.parse(mapped.returnedAt):null))throw invalid('不得伪造或清除原归还时间');
  }
  const open=item.custody.filter(h=>h.returnedAt===null&&h.disposedAt===null);
  if(item.holderUserId){if(open.length!==1||open[0]!.holderUserId!==item.holderUserId||open[0]!.borrowedAt!==item.borrowedAt||original.currentHolder!==item.holderName)throw invalid('当前持有人必须与唯一未结束的历史一致');}
  else if(open.length)throw invalid('没有持有人的样衣不能有未结束持有历史');
  const active=item.requests.filter(r=>['pending','payment_pending'].includes(r.status));
  const actual=item.status==='archived'?item.archivedFromStatus:item.status;
  if(['borrow_pending','return_pending','disposal_pending','loss_payment_pending'].includes(actual??'')){if(active.length!==1)throw invalid('在途样衣必须重建唯一待处理事项');const r=active[0]!;if((actual==='borrow_pending'&&r.type!=='borrow')||(actual==='return_pending'&&r.type!=='return')||(actual==='loss_payment_pending'&&(r.type!=='loss'||r.status!=='payment_pending'))||(actual==='disposal_pending'&&['borrow','return'].includes(r.type)))throw invalid('在途事项类型不匹配');}
  else if(active.length)throw invalid('源状态没有在途事项，不得生成待办');
  const oldDisposals=Array.isArray(original.disposalHistory)?original.disposalHistory:[];
  if(item.requests.filter(r=>r.disposal&&r.status==='completed').length!==oldDisposals.length)throw invalid('处置历史数量不一致');
  const requestSources=[...oldDisposals,original.pendingTask,original.disposalRequest,...source.borrowRequests.filter(r=>r.sampleId===item.legacyId)].filter((r):r is Record<string,unknown>=>!!r&&typeof r==='object');
  for(const raw of requestSources)if(!item.requests.some(r=>r.sourceHash===sampleSourceHash(raw)))throw invalid('原在途或历史申请未完整映射');
  for(const r of item.requests){const raw=requestSources.find(v=>sampleSourceHash(v)===r.sourceHash);if(!raw)throw invalid('迁移申请缺少原始记录哈希');
   if(['sale','gift','scrap','loss'].includes(r.type)!==!!r.disposal)throw invalid('处置记录必须与申请类型对应');
   const originalType=({SOLD:'sale',SALE:'sale',GIFTED:'gift',GIFT:'gift',SCRAPPED:'scrap',SCRAP:'scrap',LOST:'loss',LOSS:'loss',BORROW:'borrow',RETURN:'return'} as Record<string,string>)[String(raw.type).toUpperCase()];if(originalType!==r.type)throw invalid('处置或交接类型与原记录不符');
   if(r.disposal&&['sale','loss'].includes(r.type)){const proposed=raw.proposedAmount??raw.amount,final=raw.finalAmount??raw.amount;if(r.disposal.proposedAmount!==null&&(proposed==null||sampleMoneyCents(proposed)!==sampleMoneyCents(r.disposal.proposedAmount)))throw invalid('处置参考金额与原记录不符');if(r.disposal.finalAmount!==null&&(final==null||sampleMoneyCents(final)!==sampleMoneyCents(r.disposal.finalAmount)))throw invalid('处置最终金额与原记录不符');}
   for(const key of r.proofObjectKeys)if(!objects.has(key))throw invalid('处置或交接凭证缺少附件映射');}
  if(['sold','gifted','scrapped','lost'].includes(item.status)){const type=({sold:'sale',gifted:'gift',scrapped:'scrap',lost:'loss'} as Record<string,string>)[item.status];if(!item.requests.some(r=>r.type===type&&r.status==='completed'&&r.disposal?.approvedAt&&(type!=='loss'||r.disposal.paidAt)))throw invalid('终态必须有对应的真实审批或赔付历史');}
 }
 return {source,report,plan};
}
export class SampleImportService{
 constructor(private readonly db:Pool,private readonly corporationId:string,private readonly projection:SampleDisposalService,private readonly events=new OperationEventRepository()){}
 private root(actor:TrustedActorContext){if(!isRootActor(actor))throw new ApplicationError('FORBIDDEN','迁移及切换仅限管理员',403);}
 async evidence(actor:TrustedActorContext,batchId:string,kind:'sample'|'log'|'borrow_request',page:number){this.root(actor);
  const rows=await this.db.query('SELECT legacy_id AS "legacyId",source_hash AS "sourceHash",source_payload AS source FROM sample_legacy_mappings WHERE batch_id=$1 AND entity_type=$2 ORDER BY legacy_id LIMIT 15 OFFSET $3',[batchId,kind,(page-1)*15]);
  const count=await this.db.query('SELECT count(*)::int n FROM sample_legacy_mappings WHERE batch_id=$1 AND entity_type=$2',[batchId,kind]);return {page,totalCount:count.rows[0].n,items:rows.rows};
 }
 private async locked<T>(work:(client:PoolClient)=>Promise<T>){const client=await this.db.connect();try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtext('sample-migration-cutover'))");const result=await work(client);await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}}
 private async closed(client:PoolClient){const row=(await client.query<{enabled:boolean}>('SELECT enabled FROM sample_write_control WHERE singleton=true FOR UPDATE')).rows[0];if(!row||row.enabled)throw conflict('样衣业务写入开启期间禁止迁移导入');}
 private async identities(client:PoolClient,plan:SampleImportPlan){
  const ids=new Set<string>(),active=new Set<string>();for(const item of plan.items){ids.add(item.purchaserUserId);if(item.holderUserId){ids.add(item.holderUserId);active.add(item.holderUserId);}for(const h of item.custody){ids.add(h.holderUserId);if(h.requestedBy)ids.add(h.requestedBy);if(h.confirmedBy)ids.add(h.confirmedBy);}for(const r of item.requests){for(const id of [r.requestedBy,r.requestedFor,r.resolvedBy,r.disposal?.responsibleUserId,r.disposal?.approvedBy,r.disposal?.paidBy])if(id)ids.add(id);if(['pending','payment_pending'].includes(r.status)){active.add(r.requestedBy);if(r.requestedFor)active.add(r.requestedFor);}}}
  for(const id of [...ids].sort()){const person=(await client.query<{usable:boolean}>(`SELECT bool_or(u.enabled AND i.active AND i.employed) AS usable FROM app_users u JOIN identity_mappings i ON i.user_id=u.id WHERE u.id=$1 AND i.provider='dingtalk' AND i.corp_id=$2 GROUP BY u.id`,[id,this.corporationId])).rows[0];if(!person||active.has(id)&&!person.usable)throw invalid('映射员工不属于当前企业或在途责任人已失效');}
 }
 async import(actor:TrustedActorContext,sourceInput:unknown,rawPlan:unknown){
  this.root(actor);const {source,report,plan}=validateSampleImport(sourceInput,rawPlan),planHash=sampleSourceHash(plan);
  const {batchId}=await stageSampleSource(this.db,actor,source);
  return this.locked(async client=>{await this.closed(client);await this.identities(client,plan);
   const previous=(await client.query<{plan_hash:string}>('SELECT plan_hash FROM sample_migration_plans WHERE batch_id=$1',[batchId])).rows[0];if(previous&&previous.plan_hash!==planHash)throw conflict('同一快照已经按其他映射导入，不能覆盖解释');
   await client.query('INSERT INTO sample_migration_plans(batch_id,plan_hash,plan,created_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',[batchId,planHash,plan,actor.actorId]);
   for(const object of [...plan.objects].sort((a,b)=>a.attachmentId.localeCompare(b.attachmentId))){const file=(await client.query<{sha256:string;size_bytes:string;status:string}>('SELECT sha256,size_bytes,status FROM attachments WHERE attachment_id=$1 FOR UPDATE',[object.attachmentId])).rows[0];if(!file||file.status!=='ready'||file.sha256!==object.sha256||Number(file.size_bytes)!==object.sizeBytes)throw invalid('已转存附件的实际哈希、字节数或上传状态不符');await client.query('INSERT INTO sample_migration_objects(batch_id,object_key,attachment_id,sha256,size_bytes) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[batchId,object.objectKey,object.attachmentId,object.sha256,object.sizeBytes]);}
   const batchIds=new Set<string>();for(const item of plan.items){const prior=(await client.query<{sample_id:string}>('SELECT sample_id FROM sample_import_keys WHERE legacy_id=$1',[item.legacyId])).rows[0];batchIds.add(prior?.sample_id??randomUUID());}
   let index=0;for(const item of plan.items){const original=source.samples.find(s=>s.id===item.legacyId)!;await this.item(client,actor,batchId,item,original,[...batchIds][index++]!,plan,batchIds,report.attachments);}
   const reportResult=await this.reconcile(client,batchId,source,plan);if(!reportResult.passed)throw conflict(`对账未通过，整批回滚：${reportResult.errors.join(',')}`);const reconciliationId=randomUUID();await client.query('INSERT INTO sample_migration_reconciliations(reconciliation_id,batch_id,plan_hash,report,passed,created_by) VALUES($1,$2,$3,$4,$5,$6)',[reconciliationId,batchId,planHash,reportResult,reportResult.passed,actor.actorId]);
   await this.events.append(client,actor,{action:'sample.migration_reconciled',entityType:'sample_migration_batch',entityId:batchId,after:{reconciliationId,sourceHash:plan.sourceHash,planHash,passed:reportResult.passed,sampleCount:source.samples.length},reason:plan.reason});
   return {batchId,reconciliationId,...reportResult};
  });
 }
 private async item(client:PoolClient,actor:TrustedActorContext,batchId:string,item:SampleImportItem,original:SampleSourceSnapshot['samples'][number],id:string,plan:SampleImportPlan,batchIds:Set<string>,objects:ReturnType<typeof inventorySampleSource>['report']['attachments']){
  const imported=(await client.query<{source_hash:string;item_version:number}>('SELECT source_hash,item_version FROM sample_import_versions WHERE batch_id=$1 AND legacy_id=$2',[batchId,item.legacyId])).rows[0];if(imported)return;
  const existing=(await client.query<{version:number}>('SELECT version FROM sample_items WHERE sample_id=$1 FOR UPDATE',[id])).rows[0];
  if(existing){const last=(await client.query<{item_version:number}>('SELECT item_version FROM sample_import_versions WHERE sample_id=$1 ORDER BY created_at DESC LIMIT 1',[id])).rows[0];if(last?.item_version!==existing.version)throw conflict('目标样衣已有业务更改，禁止最终增量覆盖');}
  const financialBefore=existing?(await client.query(`SELECT purchase_price::text AS "purchasePrice",ARRAY(SELECT attachment_id FROM sample_attachment_bindings WHERE sample_id=$1 AND purpose='purchase_receipt' AND active) AS "receiptAttachmentIds" FROM sample_financial_facts WHERE sample_id=$1`,[id])).rows[0]:null;
  const version=(existing?.version??0)+1;
  const columns=['sample_id','sample_code','status','version','brand','style_name','style_no','category','color','size','department','purchase_date','purchaser_user_id','purchaser_name','holder_user_id','holder_name','purpose','borrowed_at','storage_location','remark','external_source','external_id','created_by','created_at','updated_at','archived_from_status','archived_reason'];
  const values=[id,original.sampleCode,item.status,version,original.brand,original.styleName,original.styleNo??'',original.category??'',original.color,original.size??'',original.department,original.purchaseDate,item.purchaserUserId,original.purchaser,item.holderUserId,item.holderName,item.purpose,item.borrowedAt,item.storageLocation,original.remark??'','daxing-sample-assistant',item.legacyId,actor.actorId,original.createdAt??original.purchaseDate,original.updatedAt??original.createdAt??original.purchaseDate,item.archivedFromStatus,item.archiveReason];
  await client.query(`INSERT INTO sample_items(${columns.join(',')}) VALUES(${values.map((_,n)=>`$${n+1}`).join(',')}) ON CONFLICT(sample_id) DO UPDATE SET ${columns.filter(c=>!['sample_id','created_by','created_at'].includes(c)).map(c=>`${c}=EXCLUDED.${c}`).join(',')}`,values);
  await client.query('INSERT INTO sample_import_keys(legacy_id,sample_id) VALUES($1,$2) ON CONFLICT DO NOTHING',[item.legacyId,id]);
  await client.query('INSERT INTO sample_financial_facts(sample_id,purchase_price) VALUES($1,$2) ON CONFLICT(sample_id) DO UPDATE SET purchase_price=EXCLUDED.purchase_price,version=sample_financial_facts.version+1',[id,sampleMoneyText(sampleMoneyCents(original.purchasePrice))]);
  for(const h of item.custody){const prior=(await client.query<{custody_id:string;returned_at:Date|null;disposed_at:Date|null}>('SELECT * FROM sample_custody_records WHERE sample_id=$1 AND legacy_id=$2',[id,h.legacyId])).rows[0];if(!prior)await client.query(`INSERT INTO sample_custody_records(custody_id,sample_id,holder_user_id,holder_name,department,purpose,borrowed_at,returned_at,disposed_at,initial_custody,requested_by,confirmed_by,imported_batch_id,legacy_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[randomUUID(),id,h.holderUserId,h.holderName,h.department,h.purpose,h.borrowedAt,h.returnedAt,h.disposedAt,h.initialCustody,h.requestedBy,h.confirmedBy,batchId,h.legacyId]);
   else if(!prior.returned_at&&!prior.disposed_at&&(h.returnedAt||h.disposedAt))await client.query('UPDATE sample_custody_records SET returned_at=$2,disposed_at=$3 WHERE custody_id=$1',[prior.custody_id,h.returnedAt,h.disposedAt]);
  }
  await client.query("UPDATE sample_attachment_bindings SET active=false WHERE sample_id=$1 AND purpose='purchase_receipt'",[id]);
  for(const object of objects.filter(o=>o.sampleIds.includes(item.legacyId))){const target=plan.objects.find(o=>o.objectKey===object.objectKey)!;for(const purpose of object.purposes){if(purpose==='legacy_evidence')continue;if(!['sample_image','purchase_receipt','return_photo','disposal_proof','payment_proof'].includes(purpose))throw invalid('未知附件用途');await bindSampleAttachments(client,actor,id,[target.attachmentId],purpose as SampleAttachmentPurpose,batchIds);await client.query('UPDATE sample_attachment_bindings SET active=true WHERE sample_id=$1 AND attachment_id=$2 AND purpose=$3',[id,target.attachmentId,purpose]);}}
  const eventId=await this.events.append(client,actor,{action:'sample.imported',entityType:'sample',entityId:id,after:{batchId,legacyId:item.legacyId,sourceHash:item.sourceHash,version,status:item.status},reason:item.normalizationReason});
  await client.query('INSERT INTO sample_financial_audit(event_id,sample_id,before_state,after_state) VALUES($1,$2,$3,$4)',[eventId,id,financialBefore,{purchasePrice:sampleMoneyText(sampleMoneyCents(original.purchasePrice)),batchId,sourceHash:item.sourceHash}]);
  for(const request of [...item.requests].sort((a,b)=>Number(['pending','payment_pending'].includes(a.status))-Number(['pending','payment_pending'].includes(b.status)))){
   const prior=(await client.query<{request_id:string;status:string}>('SELECT request_id,status FROM sample_workflow_requests WHERE sample_id=$1 AND legacy_id=$2',[id,request.legacyId])).rows[0],requestId=prior?.request_id??randomUUID();
   const rawRequest=[original.pendingTask,original.disposalRequest,...(Array.isArray(original.disposalHistory)?original.disposalHistory:[])].find(r=>r&&sampleSourceHash(r)===request.sourceHash)
    ??(await client.query('SELECT source_payload FROM sample_legacy_mappings WHERE batch_id=$1 AND source_hash=$2 LIMIT 1',[batchId,request.sourceHash])).rows[0]?.source_payload??{};
   const originalRequest=rawRequest as Record<string,unknown>,originalName=(value:unknown)=>typeof value==='string'&&value.trim()?value:null;
   const archived=item.status==='archived'&&['pending','payment_pending'].includes(request.status),status=archived?'cancelled':request.status;
   await client.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,legacy_id,request_type,status,from_status,requested_by,requested_for,purpose,reason,created_at,resolved_by,resolved_at,resolution_reason,imported_batch_id,requested_by_name,requested_for_name,department)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT(request_id) DO UPDATE SET status=EXCLUDED.status,resolved_by=EXCLUDED.resolved_by,resolved_at=EXCLUDED.resolved_at,resolution_reason=EXCLUDED.resolution_reason,version=sample_workflow_requests.version+1`,[requestId,id,request.legacyId,request.type,status,request.fromStatus,request.requestedBy,request.requestedFor,request.purpose,request.reason,request.createdAt,archived?actor.actorId:request.resolvedBy,archived?new Date():request.resolvedAt,archived?'样衣归档':request.resolutionReason,batchId,originalName(originalRequest.requestedBy),originalName(originalRequest.borrower??originalRequest.expectedName),originalName(originalRequest.department)??original.department]);
   if(request.disposal){const d=request.disposal;await client.query(`INSERT INTO sample_disposals(disposal_id,request_id,sample_id,disposal_type,recipient,responsible_user_id,proposed_amount,final_amount,approved_by,approved_at,paid_by,paid_at,imported_batch_id,responsible_name,approved_by_name,paid_by_name)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) ON CONFLICT(request_id) DO UPDATE SET final_amount=EXCLUDED.final_amount,approved_by=EXCLUDED.approved_by,approved_at=EXCLUDED.approved_at,paid_by=EXCLUDED.paid_by,paid_at=EXCLUDED.paid_at`,[randomUUID(),requestId,id,request.type,d.recipient,d.responsibleUserId,d.proposedAmount,d.finalAmount,d.approvedBy,d.approvedAt,d.paidBy,d.paidAt,batchId,originalName(originalRequest.responsibleName),originalName(originalRequest.approvedBy),originalName(originalRequest.paidBy)]);}
   for(const key of request.proofObjectKeys){const target=plan.objects.find(o=>o.objectKey===key)!;const purpose=request.type==='return'?'return_photo':request.type==='loss'&&request.disposal?.paidAt?'payment_proof':'disposal_proof';await bindSampleAttachments(client,actor,id,[target.attachmentId],purpose,batchIds);await client.query('INSERT INTO sample_request_attachments(request_id,attachment_id,purpose) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[requestId,target.attachmentId,purpose]);}
   // Rebuild native todos; never import legacy QR tokens or role-password sessions.
   await this.projectionTasks(client,actor,requestId,eventId,archived,request.status);
  }
  if(item.status==='archived'){const active=item.requests.find(r=>['pending','payment_pending'].includes(r.status));let snapshot=null;if(active){const r=(await client.query('SELECT * FROM sample_workflow_requests WHERE sample_id=$1 AND legacy_id=$2',[id,active.legacyId])).rows[0];snapshot={...r,status:active.status,version:r.version-1};}await client.query('INSERT INTO sample_archive_records(event_id,sample_id,item_snapshot,request_snapshot) VALUES($1,$2,$3,$4)',[eventId,id,item,snapshot]);}
  await client.query('INSERT INTO sample_import_versions(batch_id,legacy_id,sample_id,source_hash,item_version,operation_event_id) VALUES($1,$2,$3,$4,$5,$6)',[batchId,item.legacyId,id,item.sourceHash,version,eventId]);
 }
 private async projectionTasks(client:PoolClient,actor:TrustedActorContext,requestId:string,eventId:string,archived:boolean,status:string){
  const request=(await client.query('SELECT * FROM sample_workflow_requests WHERE request_id=$1',[requestId])).rows[0];
  await this.projection.cancelImportedTasks(client,actor,requestId);
  if(!archived&&['pending','payment_pending'].includes(status))await this.projection.project(client,actor,request,eventId,'sample.imported',eventId);
 }
 private async reconcile(client:PoolClient,batchId:string,source:SampleSourceSnapshot,plan:SampleImportPlan){
  const targets=(await client.query<{legacy_id:string;sample_id:string;status:string;holder_user_id:string|null;price:string;version:number}>(`SELECT k.legacy_id,k.sample_id,s.status,s.holder_user_id,s.version,f.purchase_price::text price FROM sample_import_keys k JOIN sample_items s USING(sample_id) JOIN sample_financial_facts f USING(sample_id)`)).rows;
  const errors:string[]=[];if(targets.length!==source.samples.length)errors.push('sample_count');
  const expected={purchaseTotal:0n,managedOriginalValue:0n,disposedOriginalValue:0n,saleReceipts:0n,lossCompensation:0n},expectedStates:Record<string,number>={},actualStates:Record<string,number>={};
  for(const target of targets)actualStates[target.status]=(actualStates[target.status]??0)+1;
  const sameDate=(actual:unknown,expected:string|null)=>actual==null?expected===null:expected!==null&&new Date(String(actual)).getTime()===Date.parse(expected);
  for(const item of plan.items){const row=targets.find(r=>r.legacy_id===item.legacyId),original=source.samples.find(s=>s.id===item.legacyId)!;expectedStates[item.status]=(expectedStates[item.status]??0)+1;
   if(!row||row.status!==item.status||row.holder_user_id!==item.holderUserId||sampleMoneyCents(row.price)!==sampleMoneyCents(original.purchasePrice)){errors.push(`sample:${item.legacyId}`);continue;}
   if(item.status!=='archived'){const amount=sampleMoneyCents(original.purchasePrice);expected.purchaseTotal+=amount;expected[['sold','gifted','scrapped','lost'].includes(item.status)?'disposedOriginalValue':'managedOriginalValue']+=amount;
    for(const r of item.requests)if(r.disposal?.finalAmount){if(item.status==='sold'&&r.type==='sale'&&r.disposal.approvedAt)expected.saleReceipts+=sampleMoneyCents(r.disposal.finalAmount);if(item.status==='lost'&&r.type==='loss'&&r.disposal.paidAt)expected.lossCompensation+=sampleMoneyCents(r.disposal.finalAmount);}
   }
   const custody=(await client.query('SELECT * FROM sample_custody_records WHERE sample_id=$1',[row.sample_id])).rows;
   if(custody.length!==item.custody.length)errors.push(`custody_count:${item.legacyId}`);
   for(const h of item.custody){const t=custody.find(r=>r.legacy_id===h.legacyId);if(!t||t.holder_user_id!==h.holderUserId||t.holder_name!==h.holderName||t.department!==h.department||t.purpose!==h.purpose||t.requested_by!==h.requestedBy||t.confirmed_by!==h.confirmedBy||t.initial_custody!==h.initialCustody||!sameDate(t.borrowed_at,h.borrowedAt)||!sameDate(t.returned_at,h.returnedAt)||!sameDate(t.disposed_at,h.disposedAt))errors.push(`custody:${item.legacyId}:${h.legacyId}`);}
   const requests=(await client.query('SELECT * FROM sample_workflow_requests WHERE sample_id=$1',[row.sample_id])).rows;
   if(requests.length!==item.requests.length)errors.push(`requests_count:${item.legacyId}`);
   for(const r of item.requests){const t=requests.find(x=>x.legacy_id===r.legacyId),archived=item.status==='archived'&&['pending','payment_pending'].includes(r.status);if(!t||t.request_type!==r.type||t.status!==(archived?'cancelled':r.status)||t.requested_by!==r.requestedBy||t.requested_for!==r.requestedFor||t.from_status!==r.fromStatus)errors.push(`request:${item.legacyId}:${r.legacyId}`);
    if(t&&r.disposal){const d=(await client.query('SELECT * FROM sample_disposals WHERE request_id=$1',[t.request_id])).rows[0],e=r.disposal;if(!d||d.disposal_type!==r.type||d.responsible_user_id!==e.responsibleUserId||d.approved_by!==e.approvedBy||d.paid_by!==e.paidBy||(d.final_amount===null?e.finalAmount!==null:e.finalAmount===null||sampleMoneyCents(d.final_amount)!==sampleMoneyCents(e.finalAmount))||!sameDate(d.approved_at,e.approvedAt)||!sameDate(d.paid_at,e.paidAt))errors.push(`disposal:${item.legacyId}:${r.legacyId}`);}
    if(t&&!archived&&['pending','payment_pending'].includes(r.status)){const task=(await client.query("SELECT count(*)::int n FROM rework_todos WHERE entity_id=$1 AND dedupe_key LIKE $2 AND status IN ('pending','blocked_recipient')",[row.sample_id,`sample:${t.request_id}:%`])).rows[0];if(!task.n)errors.push(`todo:${item.legacyId}`);}
   }
  }
  if(sampleSourceHash(expectedStates)!==sampleSourceHash(actualStates))errors.push('states');
  const amountRow=(await client.query(`SELECT COALESCE(sum(f.purchase_price),0)::text AS "purchaseTotal",COALESCE(sum(f.purchase_price) FILTER(WHERE s.status NOT IN ('sold','gifted','scrapped','lost')),0)::text AS "managedOriginalValue",COALESCE(sum(f.purchase_price) FILTER(WHERE s.status IN ('sold','gifted','scrapped','lost')),0)::text AS "disposedOriginalValue",
   (SELECT COALESCE(sum(d.final_amount),0)::text FROM sample_disposals d JOIN sample_items i USING(sample_id) WHERE i.status='sold' AND d.disposal_type='sale' AND d.approved_at IS NOT NULL) AS "saleReceipts",
   (SELECT COALESCE(sum(d.final_amount),0)::text FROM sample_disposals d JOIN sample_items i USING(sample_id) WHERE i.status='lost' AND d.disposal_type='loss' AND d.paid_at IS NOT NULL) AS "lossCompensation"
   FROM sample_items s JOIN sample_financial_facts f USING(sample_id) WHERE s.status<>'archived'`)).rows[0];
  const amounts:Record<string,{expected:string;actual:string}>={};for(const [key,value]of Object.entries(expected)){const actual=sampleMoneyCents(amountRow[key]);amounts[key]={expected:sampleMoneyText(value),actual:sampleMoneyText(actual)};if(actual!==value)errors.push(`amount:${key}`);}
  const objectCount=(await client.query('SELECT count(*)::int n FROM sample_migration_objects WHERE batch_id=$1',[batchId])).rows[0].n;if(objectCount!==plan.objects.length)errors.push('object_count');
  for(const object of plan.objects){const file=(await client.query('SELECT status,sha256,size_bytes FROM attachments WHERE attachment_id=$1',[object.attachmentId])).rows[0];if(!file||file.status!=='ready'||file.sha256!==object.sha256||Number(file.size_bytes)!==object.sizeBytes)errors.push(`object:${object.objectKey}`);}
  const legacy=(await client.query('SELECT count(*)::int n FROM sample_legacy_mappings WHERE batch_id=$1',[batchId])).rows[0].n;if(legacy!==source.samples.length+source.logs.length+source.borrowRequests.length)errors.push('legacy_history_count');
  return {passed:errors.length===0,sourceHash:plan.sourceHash,sampleCount:targets.length,objectCount,legacyRecordCount:legacy,states:actualStates,amounts,errors};
 }
 async cutover(actor:TrustedActorContext,raw:unknown){this.root(actor);const input=sampleInput(SampleCutoverSchema,raw);return this.locked(async client=>{
  const current=(await client.query<{enabled:boolean}>('SELECT enabled FROM sample_write_control WHERE singleton=true FOR UPDATE')).rows[0];
  if(current?.enabled===(input.action==='enable')){const prior=(await client.query('SELECT event_id FROM sample_cutover_events ORDER BY created_at DESC,event_id DESC LIMIT 1')).rows[0];return {enabled:current.enabled,eventId:prior?.event_id??null};}
  if(input.action==='enable'){const row=(await client.query<{passed:boolean;report:{sourceHash:string};batch_id:string}>(`SELECT passed,report,batch_id FROM sample_migration_reconciliations WHERE reconciliation_id=$1`,[input.reconciliationId])).rows[0];if(!row?.passed||row.report.sourceHash!==input.sourceHash)throw conflict('切换必须引用本次最终源快照的通过对账');
   const newest=(await client.query<{reconciliation_id:string}>('SELECT reconciliation_id FROM sample_migration_reconciliations ORDER BY created_at DESC,reconciliation_id DESC LIMIT 1')).rows[0];if(newest?.reconciliation_id!==input.reconciliationId)throw conflict('必须使用最新一次最终对账');
   const repeated=(await client.query('SELECT count(*)::int n FROM sample_migration_reconciliations WHERE batch_id=$1 AND passed',[row.batch_id])).rows[0];if(repeated.n<2)throw conflict('相同迁移必须完成两次重复执行及对账预演');
   const stored=(await client.query('SELECT plan FROM sample_migration_plans WHERE batch_id=$1',[row.batch_id])).rows[0];
   const batch=(await client.query('SELECT source_updated_at FROM sample_migration_batches WHERE batch_id=$1',[row.batch_id])).rows[0];const payloads=(await client.query('SELECT entity_type,source_payload FROM sample_legacy_mappings WHERE batch_id=$1 ORDER BY legacy_id',[row.batch_id])).rows;
   const source={updatedAt:batch.source_updated_at,samples:payloads.filter(r=>r.entity_type==='sample').map(r=>r.source_payload),logs:payloads.filter(r=>r.entity_type==='log').map(r=>r.source_payload),borrowRequests:payloads.filter(r=>r.entity_type==='borrow_request').map(r=>r.source_payload)};
   const fresh=await this.reconcile(client,row.batch_id,source,SampleImportPlanSchema.parse(stored.plan));if(!fresh.passed)throw conflict('切换前重新对账发现数据或附件变化');
   const changed=await client.query(`SELECT 1 FROM sample_import_versions v JOIN sample_items s USING(sample_id) WHERE v.batch_id=$1 AND v.item_version<>s.version LIMIT 1`,[row.batch_id]);if(changed.rows.length)throw conflict('对账后数据发生变化，必须重新核对');
  }
  const eventId=await this.events.append(client,actor,{action:`sample.writes_${input.action==='enable'?'enabled':'disabled'}`,entityType:'sample_write_control',entityId:'primary',after:{enabled:input.action==='enable',...('reconciliationId' in input?{reconciliationId:input.reconciliationId}: {})},reason:input.reason});
  await client.query('INSERT INTO sample_cutover_events(event_id,reconciliation_id,action,evidence) VALUES($1,$2,$3,$4)',[eventId,'reconciliationId' in input?input.reconciliationId:null,input.action,input]);await client.query('UPDATE sample_write_control SET enabled=$1,changed_by=$2,changed_at=CURRENT_TIMESTAMP,reason=$3 WHERE singleton=true',[input.action==='enable',actor.actorId,input.reason]);return {enabled:input.action==='enable',eventId};
 });}
}
