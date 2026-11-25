import {BulkPreparationService} from './bulk-preparation-service.js';
import {bridgePreparationMaterials} from './preparation-series-bridge.js';
import {randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {CloseMaterialInvestmentReminderSchema,PreparationMaterialRecordSchema,PreparationResponsibilitySchema,PreparationAdoptionSchema,InstructionDeliverySchema,PREPARATION_RULE_VERSION,type PreparationMaterialFact,type PreparationMaterialKind,type PreparationMaterialRecord,type PreparationResource,type ProductionReadinessState} from '@dx-rework/contracts/production-readiness';
import type {ConfirmDevelopmentSampleHandover,ConfirmDevelopmentSampleHandoverResult,DevelopmentSampleHandover,DevelopmentSampleHandoverReceipt} from '@dx-rework/contracts/digital-development-workspace';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {businessNow,acceptanceBusinessContext,observedBusinessTime} from '../acceptance-clock/business-time.js';
import {ApplicationError} from '../platform/errors.js';
import {developmentSourceLifecycle,preorderDraftOrder,workbenchPreorderPublication} from './development-source-lifecycle.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {DEVELOPMENT_HANDOVER_ENTITY,SAMPLE_HANDOVER_EVENT,designElectronicBases,designSampleHandoverHistory,readDesignElectronicHandover,readFormalDesignHandover,recordFormalDesignHandover,shareApprovedDesignVersions} from './development-electronic-handover.js';
import {formalDevelopmentHandoverEvidence} from './development-formal-handover-evidence.js';
import {orderTimeCreated} from './order-time-created.js';
import {preparationContext,preparationAvailable,preparationAdoption,preparationHash,preparationIso,preparationMaterialHistory,currentPreparationMaterials,preparationResponsibility,appendPreparationMaterial,directInvestmentInstruction,type PreparationDB} from './preparation-material-repository.js';
import {materialInvestmentReminder} from './material-investment-reminder.js';
import {productionReadiness,preparationWindow,refreshPreparationWindows} from './production-readiness-repository.js';
const conflict=(message:string):never=>{throw new ApplicationError('PREPARATION_CONFLICT',message,409);};
type PreorderRecipient={actorId:string;handover:PreparationMaterialFact;evidence:ReadonlySet<string>};
function preorderRecipientRows(rows:PreparationMaterialFact[],scope:PreorderRecipient,history=false){
 return rows.flatMap(row=>{
  if(row.kind==='design_handover')return row.recordId===scope.handover.recordId&&row.version===scope.handover.version?[row]:[];
  const own=row.recordedBy===scope.actorId;
  if(row.kind!=='material_investment'||history&&!own)return [];
  return [{...row,note:own?row.note:'',evidenceIds:row.evidenceIds.filter(id=>scope.evidence.has(id))}];
 });
}
async function preorderRecipientScope(db:PreparationDB,actorId:string,handover:PreparationMaterialFact,history:PreparationMaterialFact[]):Promise<PreorderRecipient>{
 const priorIds=history.filter(row=>row.kind==='material_investment'&&row.recordedBy===actorId).flatMap(row=>row.evidenceIds);
 const own=priorIds.length?(await db.query<{attachment_id:string}>(
  "SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND entity_type='digital_preparation' AND entity_id=$3 AND status='ready'",
  [priorIds,actorId,handover.resource.id])).rows:[];
 return {actorId,handover,evidence:new Set([...handover.evidenceIds,...own.map(row=>row.attachment_id)])};
}
function usesInstructionHandover(
 context:Awaited<ReturnType<typeof preparationContext>>,
 prior:PreparationMaterialFact|undefined,
 history:readonly PreparationMaterialFact[],
){
 if(!context.orderId)return false;
 if(!context.sourceId)return true;
 // A source attached later cannot replace the original order handover stream.
 // Its most recent record may have been invalidated or withdrawn.
 return prior?.resource.kind==='order'&&prior.resource.id===context.orderId&&history.some(row=>
  row.recordId===prior.recordId&&row.scopeRef===prior.scopeRef&&row.resource.kind==='order'
  &&row.resource.id===context.orderId&&row.state==='ready'&&row.orderInstructionVersion!==undefined);
}
export class ProductionReadinessService{
 constructor(private readonly database:Pool,private readonly transactionClient?:PoolClient){}
 inTransaction(client:PoolClient){return new ProductionReadinessService(this.database,client);}
 private async access(db:PreparationDB,actor:TrustedActorContext,resource:PreparationResource){
  const context=await preparationContext(db,resource),policy=new DigitalProductionAccessPolicy(db),responsibility=await preparationResponsibility(db,context);
  const role=async(name:string)=>actor.actorRoles.includes(name)&&await policy.activeRole(actor.actorId,name);
  const leader=isRootActor(actor)||await role('owner_group')||await role('production_management');
  const designer=Boolean(context.source?.created_by===actor.actorId&&await role('sample_designer'));
  const history=await preparationMaterialHistory(db,context),facts=currentPreparationMaterials(history,context.orderId);
  const handover=facts.find(f=>f.kind==='design_handover'&&f.scopeRef==='whole');
  const merch=Boolean((context.order?.primary_merchandiser_id===actor.actorId||!context.order&&handover?.state==='ready'&&handover.valid&&handover.recipientId===actor.actorId)&&await role('order_merchandiser'));
  const warehouse=responsibility.warehouseWorkerId===actor.actorId&&await role('warehouse_receiver')||responsibility.warehouseWorkerId===actor.actorId&&await role('warehouse_supervisor');
  const color=responsibility.colorConfirmationWorkerId===actor.actorId&&Boolean(responsibility.colorConfirmationRole&&await role(responsibility.colorConfirmationRole));
  const readable=leader||designer||merch||warehouse||color||await policy.allowed(actor,resource.kind,resource.id,'technical');
  if(!readable)digitalForbidden();
  await acceptanceBusinessContext()?.assertScope(resource);
  // A draft recipient sees the effective handover and can continue the original
  // investment, with only currently shared evidence or their own uploaded receipts.
  const recipientOnly=!context.order&&merch&&!leader&&!designer&&!warehouse&&!color;
  const sourceDocument=recipientOnly&&context.sourceId?await developmentDocumentRow(db,context.sourceId):null;
  const numberedPreorder=sourceDocument&&context.source?.workbench_generated_number&&context.sourceId
    ?await workbenchPreorderPublication(db,context.sourceId):null;
  const preorderRecipient=handover&&preorderDraftOrder(sourceDocument?.document)&&(sourceDocument?.status==='draft'||numberedPreorder)
    ?await preorderRecipientScope(db,actor.actorId,handover,history):null;
  return {context,policy,responsibility,preorderRecipient,
   history:preorderRecipient?preorderRecipientRows(history,preorderRecipient,true):history,
   facts:preorderRecipient?preorderRecipientRows(facts,preorderRecipient):facts,
   leader,designer,merch,warehouse,color};
 }
 async authorize(actor:TrustedActorContext,resource:PreparationResource){await this.access(this.database,actor,resource);}
 async authorizeAttachmentUpload(actor:TrustedActorContext,resource:PreparationResource,transaction?:PoolClient){
  const db=transaction??this.database;
  // Serialize the attachment write with cancellation, after any object storage I/O.
  if(transaction)await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
  const {context}=await this.access(db,actor,resource);
  await this.assertPreparationActive(db,context);
 }
 private async preparationWriteBlock(db:PreparationDB,{orderId,sourceId,source}:Awaited<ReturnType<typeof preparationContext>>){
  if(!orderId&&sourceId&&source?.workbench_generated_number&&(await developmentSourceLifecycle(db,sourceId))?.is_draft)
   return '开发草稿尚未发布，请先发布后再交接或投面辅料';
  const {rows:[state]}=await db.query<{inactive:boolean;closed:boolean}>(`SELECT
   EXISTS(SELECT 1 FROM digital_production_resource_lifecycle WHERE ((resource_kind='order' AND resource_id=$1)
    OR (resource_kind='source' AND resource_id=$2)) AND state<>'active') AS inactive,
   EXISTS(SELECT 1 FROM digital_order_closures WHERE production_order_id=$1) AS closed`,[orderId,sourceId]);
  if(state!.inactive)return '订单或开发来源已暂停、取消，不能新增办理事实';
  return state!.closed?'本单已结案，原资料和实际记录保持不变':null;
 }
 private async assertPreparationActive(db:PreparationDB,context:Awaited<ReturnType<typeof preparationContext>>){
  const blocked=await this.preparationWriteBlock(db,context);
  if(blocked)conflict(blocked);
 }
 async readResponsibility(actor:TrustedActorContext,resource:PreparationResource,db:PreparationDB){
  return (await this.access(db,actor,resource)).responsibility;
 }
 private async sampleHandoverActive(db:PreparationDB,sourceId:string,orderId:string|null){
  const inactive=await db.query(`SELECT 1 FROM digital_production_resource_lifecycle WHERE ((resource_kind='order' AND resource_id=$1)
   OR (resource_kind='source' AND resource_id=$2)) AND state<>'active'`,[orderId,sourceId]);
  return !inactive.rowCount&&(!orderId||!(await db.query('SELECT 1 FROM digital_order_closures WHERE production_order_id=$1',[orderId])).rowCount);
 }
 private async accessibleDesignOrder(actor:TrustedActorContext,access:Awaited<ReturnType<ProductionReadinessService['access']>>){
  const {order,orderId}=access.context;
  return order&&orderId&&await access.policy.allowed(actor,'order',orderId,'technical')
   ?{id:orderId,version:Number(order.version),customer:String(order.customer_code)}:null;
 }
 private async sampleHandoverView(db:PreparationDB,actor:TrustedActorContext,sourceId:string,access:Awaited<ReturnType<ProductionReadinessService['access']>>):Promise<DevelopmentSampleHandover>{
  if(!access.designer&&!access.leader&&!access.merch)digitalForbidden();
  const document=await developmentDocumentRow(db,sourceId);
  if(!document||document.status!=='published')return digitalForbidden();
  const round=Number(document.round_number),documentVersion=Number(document.version);
  const original=access.facts.find(fact=>fact.kind==='design_handover'&&fact.scopeRef==='whole');
  const order=await this.accessibleDesignOrder(actor,access);
  const recipientId:string|null=order?access.context.order.primary_merchandiser_id:
   !access.context.orderId&&original?.state==='ready'&&original.valid?original.recipientId:null;
  const recipient=recipientId&&await access.policy.activeRole(recipientId,'order_merchandiser')
   ?{id:recipientId,name:(await db.query<{display_name:string|null}>('SELECT display_name FROM app_users WHERE id=$1',[recipientId])).rows[0]?.display_name??null}:null;
  const formal=order?await readFormalDesignHandover(db,order.id,sourceId):null;
  const history=await designSampleHandoverHistory(db,sourceId,round);
  const current=history.find(record=>record.recipientId===recipient?.id&&(!formal||record.documentVersion===documentVersion))??null;
  const canConfirm=access.designer&&recipient!==null&&current===null&&await this.sampleHandoverActive(db,sourceId,access.context.orderId);
  const bases=await designElectronicBases(db,sourceId,{version:documentVersion,document:document.document},order);
  const orderState=order?'available':access.context.orderId?'unavailable':'not_applicable';
  const electronic=await readDesignElectronicHandover(db,{sourceId,round,recipientId:recipient?.id??null},bases,original,orderState);
  const view={sourceId,round,documentVersion,recipient,electronic,canConfirm,current,history};
  return formal&&order?{...view,formal:{...formal,currentComplete:Boolean(formal.historicalCompletion&&
   formalDevelopmentHandoverEvidence(view,await orderTimeCreated(db,{kind:'order',id:order.id})))}}:view;
 }
 async sampleHandover(actor:TrustedActorContext,sourceId:string){
  const db=await this.database.connect();
  try{
   await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
   const view=await this.sampleHandoverView(db,actor,sourceId,await this.access(db,actor,{kind:'source',id:sourceId}));
   await db.query('COMMIT');return view;
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async confirmSampleHandover(actor:TrustedActorContext,sourceId:string,input:ConfirmDevelopmentSampleHandover,key:string):Promise<ConfirmDevelopmentSampleHandoverResult>{
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少有效操作标识');
  const db=await this.database.connect();
  try{
   await db.query('BEGIN');
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const resource={kind:'source' as const,id:sourceId};
   const access=await this.access(db,actor,resource);
   if(!access.designer||!await access.policy.lockActiveRole(actor.actorId,'sample_designer'))digitalForbidden();
   if(access.context.orderId)await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[access.context.orderId]);
   await db.query('SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE',[sourceId]);
   const view=await this.sampleHandoverView(db,actor,sourceId,await this.access(db,actor,resource));
   const command=`preparation:source:${sourceId}:sample_handover`,hash=preparationHash(input);
   const old=(await db.query<{payload_hash:string;response:DevelopmentSampleHandoverReceipt}>(
    'SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(old&&old.payload_hash!==hash)conflict('操作标识已用于不同内容');
   if(old){await db.query('COMMIT');return {handover:view,receipt:old.response};}
   if(input.round!==view.round||input.documentVersion!==view.documentVersion||input.recipientId!==view.recipient?.id
    ||!await access.policy.lockActiveRole(input.recipientId,'order_merchandiser'))conflict('本轮资料或接收人已更新，请刷新核对');
   if(!await this.sampleHandoverActive(db,sourceId,access.context.orderId))
    conflict('本单已停止办理，原样衣交接保留');
   const receipt=view.current??{
    ...input,eventId:randomUUID(),recipientName:view.recipient!.name,confirmedBy:actor.actorId,
    confirmedByName:(await db.query<{display_name:string|null}>('SELECT display_name FROM app_users WHERE id=$1',[actor.actorId])).rows[0]?.display_name??null,
    occurredAt:businessNow().toISOString(),
   };
   if(!view.current){
    const {round,documentVersion,recipientId,recipientName,occurredAt}=receipt;
    await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,[receipt.eventId,actor.requestId,actor.actorId,SAMPLE_HANDOVER_EVENT,DEVELOPMENT_HANDOVER_ENTITY,sourceId,
     JSON.stringify({round,documentVersion,recipientId,recipientName,occurredAt})]);
   }
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(receipt)]);
   const orderId=access.context.orderId;
   if(view.formal&&orderId)await recordFormalDesignHandover(db,actor,orderId,{sourceId,round:input.round,recipientId:input.recipientId},input.documentVersion,view.electronic,receipt);
   const handover=view.formal?await this.sampleHandoverView(db,actor,sourceId,await this.access(db,actor,resource))
    :view.current?view:{...view,current:receipt,canConfirm:false,history:[receipt,...view.history]};
   await db.query('COMMIT');return {handover,receipt};
  }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
 }
 async read(actor:TrustedActorContext,resource:PreparationResource,db:PreparationDB=this.database):Promise<ProductionReadinessState>{
  const a=await this.access(db,actor,resource),orderId=a.context.orderId;
  const readiness=orderId?await productionReadiness(db,orderId):null;
  const adoption=await preparationAdoption(db,resource),enrolled=Boolean(orderId?readiness?.adoption:adoption);
  const revision=readiness?.revision??preparationHash({source:resource.id,facts:a.facts.map(f=>[f.recordId,f.version,f.valid]),responsibility:a.responsibility});
  const writable=!await this.preparationWriteBlock(db,a.context);
  const canRecord:PreparationMaterialKind[]=[];
  const originalHandover=a.facts.find(f=>f.kind==='design_handover'&&f.scopeRef==='whole');
  const instructionHandover=usesInstructionHandover(a.context,originalHandover,a.history);
  const root=isRootActor(actor);
  const canRecordInstructionHandover=writable&&instructionHandover&&resource.kind==='order'&&root;
  if(writable){
   if(canRecordInstructionHandover||!instructionHandover&&(root||a.designer))canRecord.push('design_handover');
   if(a.merch||root)canRecord.push('material_investment');
   if(a.warehouse||root)canRecord.push('fabric_receipt','accessories_ready','style_label_ready');
   if(a.color||root)canRecord.push('color_confirmation');
  }
  const acknowledged=orderId&&await preparationAvailable(db)?Boolean((await db.query('SELECT 1 FROM digital_preparation_adoption_acknowledgements WHERE production_order_id=$1 AND basis_revision=$2',[orderId,revision])).rowCount):false;
  const deliveries=orderId&&await preparationAvailable(db)?(await db.query('SELECT * FROM digital_instruction_deliveries WHERE production_order_id=$1 ORDER BY recorded_at,event_id',[orderId])).rows:[];
  const ranges=orderId&&await preparationAvailable(db)?(await db.query('SELECT r.* FROM digital_bulk_work_ranges r JOIN digital_bulk_preparations p USING(preparation_id) WHERE p.production_order_id=$1 ORDER BY r.preparation_id,r.kind,r.version,r.range_id',[orderId])).rows:[];
  const sourceDocument=a.context.sourceId?await developmentDocumentRow(db,a.context.sourceId):null;
  const sourceIsPreorderDraft=sourceDocument?.status==='draft'&&Boolean(preorderDraftOrder(sourceDocument.document))&&
   !(a.context.source?.workbench_generated_number&&await workbenchPreorderPublication(db,a.context.sourceId!));
  const handover=a.facts.find(f=>f.kind==='design_handover'&&f.scopeRef==='whole'&&f.state==='ready'&&f.valid&&f.investmentScopeBasis);
  const investment=a.facts.find(f=>f.kind==='material_investment'&&f.scopeRef==='whole');
  const reminder=handover&&orderId&&!(investment?.state==='ready'&&investment.valid)?await materialInvestmentReminder(db,{sourceId:a.context.sourceId,orderId,handoverId:handover.recordId,scopeFingerprint:handover.investmentScopeBasis!.fingerprint}):null;
  const orderInstruction=canRecordInstructionHandover&&orderId?await directInvestmentInstruction(db,orderId):null;
  return {...(reminder?{materialInvestmentReminder:{...reminder,canClose:writable&&!reminder.termination&&reminder.enabled
   &&reminder.status!=='waiting'&&(a.merch||root)}}:{}),...(canRecordInstructionHandover?{orderInstructionVersion:orderInstruction?.version??null}:{}),sourceIsPreorderDraft:sourceIsPreorderDraft===true,sourceDocumentVersion:sourceDocument?.version??null,lines:a.context.lines.map(l=>({lineId:l.line_id,color:l.color,orderQuantity:l.order_quantity})),resource,orderId,sourceId:a.context.sourceId,enrolled,ruleVersion:enrolled?PREPARATION_RULE_VERSION:null,revision,facts:a.facts,history:a.history,canRecord,responsibility:a.responsibility,canAssign:writable&&a.leader,
   canDeliverInstruction:writable&&(a.merch||root),canAcknowledgeAdoption:writable&&!enrolled&&Boolean(orderId)&&(a.merch||root),canAdopt:writable&&!enrolled&&Boolean(orderId)&&a.leader&&acknowledged,adoptionAcknowledged:acknowledged,
   adoptionReason:enrolled?null:'历史单未自动套用；主跟单核对预览后由供应链总监、老板或 Root 明确采用，完成实绩不重算',finalReasons:readiness?.finalReasons??[],technicalRevision:readiness?.technical?.revision??null,
   draftWindow:orderId?await preparationWindow(db,orderId,'draft'): {startedAt:null,dueAt:null,completedAt:null,minutes:null,reason:'正式单形成前保留真实投料及到仓记录',status:'waiting'},
   finalWindow:orderId?await preparationWindow(db,orderId,'final',readiness?.finalReasons):{startedAt:null,dueAt:null,completedAt:null,minutes:null,reason:null,status:'waiting'},
   instructionDeliveries:deliveries.map(r=>({eventId:r.event_id,instructionVersion:r.instruction_version,recipient:r.recipient,occurredAt:preparationIso(r.occurred_at)!,note:r.note,evidenceIds:r.evidence_ids})),
   ranges:ranges.map(r=>({rangeId:r.range_id,preparationId:r.preparation_id,kind:r.kind,version:r.version,lineIds:r.line_ids,complete:r.complete,pendingMaterialIds:r.pending_material_ids,note:r.note,recordedAt:preparationIso(r.occurred_at)!,evidenceIds:r.evidence_ids,basis:r.basis_json}))};
 }
 private async command(actor:TrustedActorContext,resource:PreparationResource,action:string,input:unknown,key:string,work:(db:PoolClient,a:Awaited<ReturnType<ProductionReadinessService['access']>>)=>Promise<void>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))conflict('缺少有效操作标识');
  const db=this.transactionClient??await this.database.connect();try{
   if(!this.transactionClient)await db.query('BEGIN');
   await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const a=await this.access(db,actor,resource);
   if(!await preparationAvailable(db))conflict('产前资料版本尚未安装');
   if(a.context.orderId)await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[a.context.orderId]);
   if(a.context.sourceId)await db.query('SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE',[a.context.sourceId]);
   await this.assertPreparationActive(db,a.context);
   const record=action==='record'?input as PreparationMaterialRecord:null;
   const instructionHandover=record?.kind==='design_handover'&&usesInstructionHandover(a.context,
    a.facts.find(f=>f.kind===record.kind&&f.scopeRef===record.scopeRef),a.history);
   // The original order route owns both range authorization and write retries.
   if(instructionHandover&&resource.kind!=='order')digitalForbidden();
   if(!isRootActor(actor)){
    let required:string|null=null;
    if(record){
     const {kind}=record;
     if(kind==='design_handover'&&a.designer&&!instructionHandover)required='sample_designer';
     else if(kind==='material_investment'&&a.merch)required='order_merchandiser';
     else if(['fabric_receipt','accessories_ready','style_label_ready'].includes(kind)&&a.warehouse)required=actor.actorRoles.includes('warehouse_supervisor')?'warehouse_supervisor':'warehouse_receiver';
     else if(kind==='color_confirmation'&&a.color)required=a.responsibility.colorConfirmationRole;
    }else if(action==='deliver'||action==='acknowledge'||action==='close_material_investment_reminder'){if(a.merch)required='order_merchandiser';}
    else if(a.leader)required=actor.actorRoles.includes('owner_group')?'owner_group':'production_management';
    if(!required||!await a.policy.lockActiveRole(actor.actorId,required))digitalForbidden();
   }
   const command=`preparation:${resource.kind}:${resource.id}:${action}`,hash=preparationHash(input);
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   // Eligibility is rechecked before replay; a revoked user cannot recover prior private responses.
   if(prior&&prior.payload_hash!==hash)conflict('操作标识已用于不同内容');
   if(prior){
    const response=prior.response as ProductionReadinessState,scope=a.preorderRecipient;
    if(!this.transactionClient)await db.query('COMMIT');
    return scope?{...response,history:preorderRecipientRows(response.history,scope,true),facts:preorderRecipientRows(response.facts,scope)}:response;
   }
   await work(db,a);
   if(a.context.orderId){await bridgePreparationMaterials(db,a.context,actor.actorId);await refreshPreparationWindows(db,a.context.orderId);await new BulkPreparationService(this.database).sync(db,actor,a.context.orderId);}
   const response=await this.read(actor,resource,db);
   await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_preparation',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,`preparation_${action}`,resource.id,JSON.stringify(input)]);
   if(!this.transactionClient)await db.query('COMMIT');return response;
  }catch(error){if(!this.transactionClient)await db.query('ROLLBACK');throw error;}finally{if(!this.transactionClient)db.release();}
 }
 async bindFiles(db:PreparationDB,actor:TrustedActorContext,resource:PreparationResource,ids:string[]){
  const a=await this.access(db,actor,resource);
  const source=a.context.sourceId?await developmentDocumentRow(db,a.context.sourceId):null;
  const handover=a.merch?a.facts.find(f=>f.kind==='design_handover'&&f.state==='ready'&&f.valid):undefined;
  const sourceFiles=source&&(source.status==='published'||a.designer||isRootActor(actor))
   ?source.document.files.map((f:{attachmentId:string})=>f.attachmentId):handover?.evidenceIds??[];
  for(const id of [...ids].sort()){
   const row=(await db.query('SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE',[id])).rows[0];
   if(!row||row.status!=='ready')conflict('凭证尚未上传完成或已失效');
   if(row.entity_type==='digital_preparation'&&[a.context.sourceId,a.context.orderId].includes(row.entity_id)){
    if(a.preorderRecipient&&!a.preorderRecipient.evidence.has(id))digitalForbidden();
    continue;
   }
   if(row.entity_type==='digital_development'&&row.entity_id===a.context.sourceId&&sourceFiles.includes(id)&&
    (!a.preorderRecipient||a.preorderRecipient.evidence.has(id)))continue;
   if(row.entity_type||row.uploaded_by!==actor.actorId)digitalForbidden();
   await db.query("UPDATE attachments SET entity_type='digital_preparation',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1",[id,resource.id]);
  }
 }
 async record(actor:TrustedActorContext,resource:PreparationResource,raw:PreparationMaterialRecord,key:string){
  const input=PreparationMaterialRecordSchema.parse(raw);
  return this.command(actor,resource,'record',input,key,async(db,a)=>{
   const state=await this.read(actor,resource,db);if(!state.canRecord.includes(input.kind))digitalForbidden();
   if(input.occurredAt&&Date.parse(input.occurredAt)>businessNow().getTime())conflict('实际时间不能在未来');
   const prior=a.facts.find(f=>f.kind===input.kind&&f.scopeRef===input.scopeRef);
   if((prior?.version??0)!==input.expectedVersion)conflict('本项资料已更新，请刷新后追加订正');
   if(input.kind==='design_handover'){
    const useInstruction=usesInstructionHandover(a.context,prior,a.history);
    if(!useInstruction&&input.orderInstructionVersion!==undefined)conflict('设计交接须引用当前已保存投料草稿或有效发布资料版本');
    if(input.state==='ready'){
     if(!input.recipientId||!await a.policy.lockActiveRole(input.recipientId,'order_merchandiser'))conflict('请指定有效订单跟单接收资料');
     if(a.context.order?.primary_merchandiser_id&&a.context.order.primary_merchandiser_id!==input.recipientId)conflict('请交给本单主跟单，不另建第二责任人');
     if(useInstruction&&a.context.orderId){
      const instruction=await directInvestmentInstruction(db,a.context.orderId);
      if(input.sourceDocumentVersion!==null||input.orderInstructionVersion!==instruction?.version||a.context.sourceId&&!instruction)
       conflict('设计交接须引用当前已保存的本单制单版本；资料变更后请重新读取');
     }else if(a.context.sourceId){
      const d=await developmentDocumentRow(db,a.context.sourceId);
      const preorder=d?.status==='draft'&&d.document.customerOrderDraft?.withOrder===true&&d.document.customerOrderDraft.stage==='preorder';
      if(!d||d.status!=='published'&&!preorder||d.version!==input.sourceDocumentVersion)
       conflict('设计交接须引用当前已保存投料草稿或有效发布资料版本');
      if(preorder&&!d.document.materials.some((m:{category:string;name:string;quantity:string})=>m.category!=='辅料'&&m.name.trim()&&m.quantity.trim()))
       conflict('预下单交接请先保存实际面料名称和数量资料；不要求完整尺码、预算或正式单');
     }
    }
   }
   if(input.kind==='color_confirmation'&&a.context.order?.requires_color_matching===false)conflict('设计已选择无需对色，不重复建立确认步骤');
   for(const q of input.quantities){
    if(q.lineId&&!a.context.lines.some(l=>l.line_id===q.lineId))conflict('物料款色不属于本单');
    if(q.materialId){const d=a.context.sourceId?await developmentDocumentRow(db,a.context.sourceId):null;const instruction=a.context.orderId?(await db.query('SELECT document FROM digital_instruction_documents WHERE production_order_id=$1',[a.context.orderId])).rows[0]:null;
     const retained=input.kind==='material_investment'&&prior?.investmentScopeBasis&&prior.quantities.some(row=>
      row.materialId===q.materialId&&row.lineId===q.lineId&&row.unit===q.unit&&row.name===q.name&&row.quantity===q.quantity);
     if(!d?.document.materials.some((m:{materialId:string})=>m.materialId===q.materialId)&&!instruction?.document.accessories.some((m:{id:string})=>m.id===q.materialId)
       &&!instruction?.document.fabrics?.some((m:{id:string})=>m.id===q.materialId)&&!retained)
      conflict('物料不属于本单当前资料');}
   }
   if(input.kind==='material_investment'&&['ready','partial'].includes(input.state)){
    const handover=a.facts.find(row=>row.kind==='design_handover'&&row.scopeRef===input.scopeRef&&row.state==='ready'&&row.valid);
    const materialIds=handover?.investmentScopeBasis?.materialIds;
    if(materialIds&&input.quantities.some(row=>!prior?.quantities.some(previous=>
       row.materialId===previous.materialId&&row.lineId===previous.lineId&&row.unit===previous.unit&&row.name===previous.name&&row.quantity===previous.quantity)
       &&(!row.materialId||!materialIds.includes(row.materialId))))conflict('新增投面辅料须选择本次实际交接的物料');
   }
   await this.bindFiles(db,actor,resource,input.evidenceIds);
   await appendPreparationMaterial(db,a.context,actor.actorId,input);
   if(resource.kind==='source'&&a.designer&&input.kind==='design_handover'&&input.scopeRef==='whole'&&input.state==='ready')
    await shareApprovedDesignVersions(db,actor,resource.id);
  });
 }
 async closeMaterialInvestmentReminder(actor:TrustedActorContext,resource:PreparationResource,raw:unknown,key:string){
  const input=CloseMaterialInvestmentReminderSchema.parse(raw);
  return this.command(actor,resource,'close_material_investment_reminder',input,key,async(db,a)=>{
   if(!a.merch&&!isRootActor(actor))digitalForbidden();
   const current=(await this.read(actor,resource,db)).materialInvestmentReminder;
   if(!current||current.fingerprint!==input.fingerprint||!current.enabled||current.termination||current.status==='waiting')
    return conflict('当前没有可关闭的投面辅料提醒，请重新读取');
   if(current.closed)return;
   await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
    VALUES($1,$2,$3,'preparation_material_reminder_closed','digital_material_investment',$4,$5)`,[randomUUID(),actor.requestId,actor.actorId,current.handoverId,
    JSON.stringify({...current,reason:input.reason,occurredAt:businessNow().toISOString()})]);
  });
 }
 async assign(actor:TrustedActorContext,resource:PreparationResource,raw:unknown,key:string){
  const input=PreparationResponsibilitySchema.parse(raw);return this.command(actor,resource,'assign',input,key,async(db,a)=>{
   if(!a.leader)digitalForbidden();if(a.responsibility.version!==input.expectedVersion)conflict('人员安排已更新，请刷新');
   if(input.warehouseWorkerId&&!await a.policy.lockActiveRole(input.warehouseWorkerId,'warehouse_receiver'))conflict('收料人须为在职有效仓库岗位');
   if(input.colorConfirmationWorkerId&&(!input.colorConfirmationRole||!await a.policy.lockActiveRole(input.colorConfirmationWorkerId,input.colorConfirmationRole)))conflict('对色确认人须具备所选有效岗位，不在此授予新角色');
   await db.query(`INSERT INTO digital_preparation_responsibilities(resource_kind,resource_id,version,warehouse_worker_id,color_confirmation_worker_id,color_confirmation_role,reason,actor_id,occurred_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[resource.kind,resource.id,input.expectedVersion+1,input.warehouseWorkerId,input.colorConfirmationWorkerId,input.colorConfirmationRole,input.reason,actor.actorId,businessNow().toISOString()]);
  });
 }
 async adopt(actor:TrustedActorContext,resource:PreparationResource,raw:unknown,key:string,acknowledge=false){
  const input=PreparationAdoptionSchema.parse(raw);return this.command(actor,resource,acknowledge?'acknowledge':'adopt',input,key,async(db,a)=>{
   if(resource.kind!=='order')conflict('历史采用须从订单预览办理');
   const state=await this.read(actor,resource,db);if(state.enrolled||state.revision!==input.previewRevision)conflict('预览版本已变化，请重新核对；不自动改写在途计划或已完成实绩');
   if(acknowledge){if(!state.canAcknowledgeAdoption)digitalForbidden();await db.query(`INSERT INTO digital_preparation_adoption_acknowledgements(acknowledgement_id,production_order_id,basis_revision,reason,actor_id,business_time)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(production_order_id,basis_revision) DO NOTHING`,[randomUUID(),resource.id,state.revision,input.reason,actor.actorId,JSON.stringify(observedBusinessTime())]);}
   else{if(!state.canAdopt)digitalForbidden();const original=(await db.query('SELECT version,published_version FROM digital_instruction_documents WHERE production_order_id=$1',[resource.id])).rows[0];const ack=(await db.query('SELECT actor_id FROM digital_preparation_adoption_acknowledgements WHERE production_order_id=$1 AND basis_revision=$2',[resource.id,state.revision])).rows[0];
    await db.query(`INSERT INTO digital_preparation_rule_adoptions(adoption_id,resource_kind,resource_id,revision,rule_version,basis_revision,reason,standards,acknowledged_by,adopted_by,creation_event_id,business_time)
     VALUES($1,'order',$2,1,$3,$4,$5,$6,$7,$8,NULL,$9)`,[randomUUID(),resource.id,PREPARATION_RULE_VERSION,state.revision,input.reason,JSON.stringify({draftMinutes:1440,finalMinutes:1440,retainedDraftVersion:original?.version??0,retainedInstructionVersion:original?.published_version??null,retainedTechnicalRevision:state.technicalRevision}),ack.actor_id,actor.actorId,JSON.stringify(observedBusinessTime())]);}
   void a;
  });
 }
 async deliver(actor:TrustedActorContext,orderId:string,raw:unknown,key:string){
  const input=InstructionDeliverySchema.parse(raw);return this.command(actor,{kind:'order',id:orderId},'deliver',input,key,async(db,a)=>{
   if(!a.merch&&!isRootActor(actor))digitalForbidden();if(Date.parse(input.occurredAt)>businessNow().getTime())conflict('交付发生时间不能在未来');
   const version=(await db.query('SELECT published_at FROM digital_instruction_versions WHERE production_order_id=$1 AND version=$2',[orderId,input.instructionVersion])).rows[0];
   if(!version||Date.parse(input.occurredAt)<new Date(version.published_at).getTime())conflict('须交付已正式发布版本，实际交付不能早于该版发布');
   await this.bindFiles(db,actor,{kind:'order',id:orderId},input.evidenceIds);
   await db.query(`INSERT INTO digital_instruction_deliveries(event_id,production_order_id,instruction_version,recipient,occurred_at,note,evidence_ids,actor_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[randomUUID(),orderId,input.instructionVersion,input.recipient,input.occurredAt,input.note,input.evidenceIds,actor.actorId]);
  });
 }
 async canDownload(actor:TrustedActorContext,resource:PreparationResource,attachmentId:string){
  const a=await this.access(this.database,actor,resource);
  if(a.preorderRecipient)return a.preorderRecipient.evidence.has(attachmentId);
  if(a.history.some(f=>f.evidenceIds.includes(attachmentId)))return true;
  if(!a.context.orderId)return false;
  return Boolean((await this.database.query(`SELECT 1 FROM digital_instruction_deliveries WHERE production_order_id=$1 AND $2=ANY(evidence_ids)
   UNION ALL SELECT 1 FROM digital_bulk_work_ranges r JOIN digital_bulk_preparations p USING(preparation_id) WHERE p.production_order_id=$1 AND $2=ANY(r.evidence_ids)`,[a.context.orderId,attachmentId])).rowCount);
 }
}
