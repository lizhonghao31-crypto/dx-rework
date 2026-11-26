import {validateSpecialCraftChoices} from './special-craft-library.js';
import {sameDevelopmentMaterialBasis} from './development-commercial-fields.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {assembleQuotation} from './quotation-assembly.js';
import {captureTechnicalRound} from './development-cycle-evidence.js';
import {technicalEnrollment,inheritTechnicalArtifact,publishedTechnicalArtifact} from './development-technical-repository.js';
import {DevelopmentTechnicalService} from './development-technical-service.js';
import {createIndependentDevelopmentRevision} from './development-revision-source.js';
import {developmentRevisionCommentAdoptionReady,readDevelopmentRevisionCommentBasis} from './development-revision-comment-basis.js';
import {businessNow,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {captureDevelopmentTimeline} from './fixed-development-adoption.js';
import {developmentSlaPlan} from "./development-sla-enrollment.js";
import {captureDeferredDevelopmentRoute,deferredDevelopmentRoute} from './development-native-route.js';
import {validateAuxiliaryReferences} from '../access/auxiliary-catalog-service.js';
import {validateDevelopmentMaterialSuppliers} from './development-material-suppliers.js';
import {isRootActor} from '../access/business-authority.js';
import {developmentRevisionForSave,validateDevelopmentMaterialPlan,withDevelopmentMaterialLineTotals} from "./development-document-format.js";
import {authorizePatternOrder} from "../pattern-room/order-authority.js";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {DevelopmentRevisionSchema,PublishDevelopmentRevisionSchema,type DevelopmentRevision} from '@dx-rework/contracts/digital-development-rounds';
import type {z} from 'zod';
import {developmentPublishErrors,usesDevelopmentMaterialPlanning} from '@dx-rework/contracts/digital-development';
import type {TrustedActorContext} from '../tools/repositories.js';
import {ApplicationError} from '../platform/errors.js';
import {digitalForbidden} from './access-policy.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {DigitalDevelopmentService} from './development-service.js';
import {DigitalProductionTaskService} from './task-service.js';
import {DevelopmentRouteService} from './development-route-service.js';
import {readDevelopmentRevisionPlan} from './development-round-plan.js';
import type {PatternRoomOrderService} from '../pattern-room/order-service.js';
import {authorizeDevelopmentReturn,linkedDevelopmentOrder} from './development-native-round.js';
import {approvedOrderTimeRevision} from './order-time-admission.js';
import {automaticOrderTime} from './order-time-automatic.js';
const fail=(message:string):never=>{throw new ApplicationError('DEVELOPMENT_REVISION_CONFLICT',message,409);};
export class DevelopmentRoundService {
 constructor(private readonly database:Pool,private readonly enabled:boolean,private readonly patternOrders?:PatternRoomOrderService,private readonly transactionClient?:PoolClient){}
 inTransaction(client:PoolClient){return new DevelopmentRoundService(this.database,this.enabled,this.patternOrders,client);}
 private forms(){return new DigitalDevelopmentService(this.database,this.enabled);}
 async read(actor:TrustedActorContext,sourceId:string){
  const sheet=await this.forms().read(actor,sourceId);
  const rounds=(await this.database.query('SELECT round_number AS "roundNumber",based_on_round AS "basedOnRound",origin,customer_comment AS "customerComment",internal_problem AS "internalProblem",explanation,categories,affected_nodes AS "affectedNodes",output_kind AS "outputKind",route_nodes AS "routeNodes",inherited,published_at AS "publishedAt" FROM digital_development_rounds WHERE source_id=$1 ORDER BY round_number',[sourceId])).rows;
  const draft=sheet.canEdit?(await this.database.query('SELECT version,payload FROM digital_development_round_drafts WHERE source_id=$1',[sourceId])).rows[0]??null:null;
  return {rounds,draft};
 }
 private async command<T>(actor:TrustedActorContext,sourceId:string,action:string,key:string,input:unknown,work:(db:PoolClient)=>Promise<T>){
  if(!this.enabled)digitalForbidden();if(!/^[A-Za-z0-9._:-]{1,100}$/.test(key))fail('缺少有效操作标识');
  const db=this.transactionClient??await this.database.connect();try{
   if(!this.transactionClient)await db.query('BEGIN');await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const sheet=await this.forms().read(actor,sourceId,db);if(!sheet.canEdit||sheet.status!=='published')digitalForbidden();
   const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];if(lifecycle&&lifecycle.state!=='active')fail('开发单已暂停或取消');
   const command=`development-round:${sourceId}:${action}`,hash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
   const prior=(await db.query('SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)fail('同一操作标识不能用于不同内容');
   const result=prior?prior.response as T:await work(db);
   if(!prior)await db.query('INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)',[actor.actorId,command,key,hash,JSON.stringify(result)]);
   if(!this.transactionClient)await db.query('COMMIT');return result;
  }catch(error){if(!this.transactionClient)await db.query('ROLLBACK');throw error;}finally{if(!this.transactionClient)db.release();}
 }
 async save(actor:TrustedActorContext,sourceId:string,input:{expectedDraftVersion:number;revision:DevelopmentRevision},key:string){
  return this.command(actor,sourceId,'save',key,input,async db=>{
   const sheet=await this.forms().read(actor,sourceId,db);if((sheet.roundNumber??1)!==input.revision.basedOnRound)fail('已有新轮次，请重新读取当前资料');
   const before=(await db.query('SELECT version,payload FROM digital_development_round_drafts WHERE source_id=$1 FOR UPDATE',[sourceId])).rows[0];if((before?.version??0)!==input.expectedDraftVersion)fail('复版草稿已更新，请刷新');
   const revision={...input.revision,document:developmentRevisionForSave(input.revision.document,sheet.document!)};
   if(sheet.materialForecastOnly||!isRootActor(actor)&&(usesDevelopmentMaterialPlanning(revision.document)||usesDevelopmentMaterialPlanning(sheet.document)))
    validateDevelopmentMaterialPlan(revision.document,sheet.document!);
   await validateAuxiliaryReferences(db,revision.document,before?.payload?.document??sheet.document!);
   await validateDevelopmentMaterialSuppliers(db,revision.document,before?.payload?.document??sheet.document!,{catalog:Boolean(sheet.document!.materialSupplierCatalog)});
   await this.forms().bindFiles(db,actor,sourceId,revision.document);
   await db.query('INSERT INTO digital_development_round_drafts(source_id,version,based_on_round,payload,updated_by) VALUES($1,1,$2,$3,$4) ON CONFLICT(source_id) DO UPDATE SET version=digital_development_round_drafts.version+1,based_on_round=$2,payload=$3,updated_by=$4,updated_at=CURRENT_TIMESTAMP',[sourceId,input.revision.basedOnRound,JSON.stringify(revision),actor.actorId]);
   return {draftVersion:input.expectedDraftVersion+1};
  });
 }
 async publish(actor:TrustedActorContext,sourceId:string,raw:z.input<typeof PublishDevelopmentRevisionSchema>,key:string){
  const input=PublishDevelopmentRevisionSchema.parse(raw);
  return this.command(actor,sourceId,'publish',key,input,async db=>{
   if(input.publishCurrent&&input.revision?.customerCommentRef){
    const contentHash=createHash('sha256').update(JSON.stringify(input)).digest('hex');
    const repeated=await db.query(`SELECT response FROM digital_production_commands
     WHERE actor_id=$1 AND command=$2 AND payload_hash=$3 ORDER BY key LIMIT 1`,
    [actor.actorId,`development-round:${sourceId}:publish`,contentHash]);
    if(repeated.rows[0])return repeated.rows[0].response;
   }
   const draft=(await db.query('SELECT * FROM digital_development_round_drafts WHERE source_id=$1 FOR UPDATE',[sourceId])).rows[0];
   if((draft?.version??0)!==input.expectedDraftVersion||draft&&draft.based_on_round!==input.basedOnRound)fail('复版草稿已变化，请刷新后发布');
   const submitted=input.revision??(draft?DevelopmentRevisionSchema.parse(draft.payload):fail('请先读取本轮复版资料'));
   const sheet=await this.forms().read(actor,sourceId,db);
   if(input.publishCurrent&&input.expectedBasisVersion!==sheet.version)fail('续版依据已更新，请读取当前版单后再发布');
   let revision=input.revision?{...submitted,document:developmentRevisionForSave(submitted.document,sheet.document!)}:submitted;
   const ref=revision.customerCommentRef,repeat=revision.repeatOriginalComment;
   let adoptionNumber=1;
   if(ref){
    if(!await developmentRevisionCommentAdoptionReady(db))fail('本轮客户评语引用功能尚未就绪');
    if(!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(db).lockActiveRole(actor.actorId,'sample_designer'))digitalForbidden();
    const previous=(await db.query<{source_id:string;round_number:number;sequence:number|null}>(`SELECT a.source_id,a.round_number,
     (to_jsonb(a)->>'adoption_number')::int AS sequence FROM digital_development_revision_comment_adoptions a
     WHERE a.comment_id=$1 ORDER BY COALESCE((to_jsonb(a)->>'adoption_number')::int,1) DESC LIMIT 1`,[ref.commentId])).rows[0];
    if(repeat){
     if(!input.publishCurrent||!previous?.sequence||repeat.sourceId!==sourceId||previous.source_id!==sourceId||
       previous.round_number!==repeat.roundNumber||(sheet.roundNumber??1)!==input.basedOnRound||sheet.status!=='published')
       return fail('再次发起须从同条评语最近一次实际发布的复版结果办理');
     adoptionNumber=previous.sequence+1;
    }else{
     if(ref.sourceId!==sourceId||ref.roundNumber!==input.basedOnRound||ref.roundNumber!==(sheet.roundNumber??1))
      fail('请选择本单当前轮次的客户评语');
     if(previous)fail('此版客户评语已建立复版，请打开原复版单');
    }
    const original=await readDevelopmentRevisionCommentBasis(db,ref)??fail('原客户评语已不可用，请重新核对');
    if(original.decision!=='changes_required'&&(original.final||original.decision!=='noted'))fail('本条客户意见未要求修改，不能作为复版依据');
    revision={...revision,customerComment:original.text};
   }
   if(input.revision)await this.forms().bindFiles(db,actor,sourceId,revision.document);
   const publish=()=>this.publishWithClient(db,actor,sourceId,revision,undefined,undefined,input.publishCurrent===true);
   // A customer revision creates a separate inactive draft. Its original
   // publication later runs the same first-effective check as any new source.
   const result=revision.origin!=='内部发现'?await publish():await automaticOrderTime(this.database,db,actor,{kind:'development_revision',sourceId,input},publish,result=>({kind:'source',id:result.sourceId}));
   if(ref)await db.query(`INSERT INTO digital_development_revision_comment_adoptions(source_id,round_number,based_on_source_id,based_on_round,based_on_scope,comment_id,comment_version,adopted_by${repeat?',adoption_number,previous_source_id,previous_round_number':''})
     VALUES($1,$2,$3,$4,$5,$6,$7,$8${repeat?',$9,$10,$11':''})`,[result.sourceId,result.roundNumber,ref.sourceId,ref.roundNumber,ref.scopeRef,
     ref.commentId,ref.version,actor.actorId,...(repeat?[adoptionNumber,repeat.sourceId,repeat.roundNumber]:[])]);
   if(draft)await db.query('DELETE FROM digital_development_round_drafts WHERE source_id=$1',[sourceId]);
   if(!input.publishCurrent||result.sourceId===sourceId)return result;
   const first=new DigitalDevelopmentService(this.database,this.enabled,this.patternOrders).inTransaction(db);
   const row=await first.read(actor,result.sourceId,db);
   const patternOrder=revision.outputKind==='工艺布片'?undefined:input.patternOrder;
   if(this.patternOrders&&revision.outputKind==='整件样板'&&!patternOrder)fail('请核对本次独立复版的打板品类与执行价');
   const firstKey=createHash('sha256').update(`independent-development:${result.sourceId}:${row.version}`).digest('hex');
   await db.query('SAVEPOINT independent_first_publication');
   try{
    const published=await first.publish(actor,result.sourceId,row.version,firstKey,patternOrder);
    if(published.status!=='published'||!published.taskId)fail('未取得独立复版原生发布和任务回执');
    await db.query('RELEASE SAVEPOINT independent_first_publication');
    return {...result,status:'published' as const,documentVersion:published.version};
   }catch(error){
    await db.query('ROLLBACK TO SAVEPOINT independent_first_publication');
    await db.query('RELEASE SAVEPOINT independent_first_publication');
    if(!(error instanceof ApplicationError)||!['ORDER_TIME_REQUEST_REQUIRED','ORDER_TIME_INPUT_REQUIRED'].includes(error.code))throw error;
    return {...result,status:error.code==='ORDER_TIME_REQUEST_REQUIRED'?'needs_time_request' as const:'needs_inputs' as const,
     documentVersion:row.version,reason:error.message,...(patternOrder?{patternOrder}:{})};
   }
  });
 }
 async publishWithClient(db:PoolClient,actor:TrustedActorContext,sourceId:string,input:DevelopmentRevision,returnTaskId?:string,patternReworkRoundId?:string,directPublication=false){
  if(!this.enabled)digitalForbidden();
  const rawBasis=await developmentDocumentRow(db,sourceId);
  if(rawBasis)input={...input,document:withDevelopmentMaterialLineTotals({...input.document,
   ...(rawBasis.document.quotationMode?{quotationMode:rawBasis.document.quotationMode}:{}),
   materialSupplierCatalog:rawBasis.document.materialSupplierCatalog,
   materials:input.document.materials.map(material=>{
    const original=rawBasis.document.materials.find((row:{materialId:string})=>row.materialId===material.materialId);
    const basis=material.auxiliaryCatalog,previous=original?.auxiliaryCatalog;
    return {...material,
     ...(rawBasis.document.quotationMode&&material.unitPrice===undefined&&original?.unitPrice!==undefined?{unitPrice:original.unitPrice}:{}),
     ...(basis&&previous?.id===basis.id&&previous.version===basis.version&&basis.referencePricing===undefined&&previous.referencePricing!==undefined
      ?{auxiliaryCatalog:{...basis,referencePricing:previous.referencePricing}}:{}),
    };
   }),
  })};
  const parsed=DevelopmentRevisionSchema.safeParse(input);if(!parsed.success)fail(parsed.error.issues[0]?.message??"复版资料无效");input=parsed.data!;
  const sheet=await this.forms().read(actor,sourceId,db);
  // A technical return carries the commercial basis forward without granting
  // its assignee the designer's price-writing authority.
  if(!sheet.canEdit&&rawBasis){
   for(const material of input.document.materials){
    const original=rawBasis.document.materials.find((m:{materialId:string})=>m.materialId===material.materialId);
    if(material.unitPrice!==undefined&&material.unitPrice!==original?.unitPrice)digitalForbidden();
   }
  }
  if(input.document.orderDate!==sheet.document!.orderDate)fail('实际复版不能改写首次开发下单日期');
  if(patternReworkRoundId){
   const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];
   if(lifecycle&&lifecycle.state!=='active')fail('开发单已暂停或取消');
   const original=(await db.query(`SELECT r.requested_by FROM digital_development_pattern_links l
     JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
     WHERE l.source_id=$1 AND r.round_id=$2 AND r.round_type='rework' AND r.status='pending_assignment'
       AND o.status='pending_assignment' AND o.deleted_at IS NULL`,[sourceId,patternReworkRoundId])).rows[0];
   if(!original||original.requested_by!==actor.actorId)digitalForbidden();
   if(returnTaskId)await authorizeDevelopmentReturn(db,actor,sourceId,returnTaskId,input.basedOnRound);
   else if(!await approvedOrderTimeRevision(db,actor,sourceId,input.basedOnRound))await authorizePatternOrder(db,actor,"pattern_room:orders:rework",true);
  }
  if(!returnTaskId&&!patternReworkRoundId&&!sheet.canEdit)digitalForbidden();
  if((!returnTaskId&&!patternReworkRoundId&&sheet.materialForecastOnly)||
    (!isRootActor(actor)&&(usesDevelopmentMaterialPlanning(input.document)||usesDevelopmentMaterialPlanning(sheet.document))))
   validateDevelopmentMaterialPlan(input.document,sheet.document!);
  if(input.basedOnRound!==(sheet.roundNumber??1))fail('已有新轮次，不能从旧版重复发布');
  if(returnTaskId){const task=(await db.query("SELECT t.route_version,a.task_kind,a.source_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE t.task_id=$1",[returnTaskId])).rows[0];if(!task||task.source_id!==sourceId||task.task_kind!=='development_tail_check'||task.route_version!==input.basedOnRound||input.origin!=='内部发现')digitalForbidden();}
  await validateAuxiliaryReferences(db,input.document,sheet.document!);
  await validateDevelopmentMaterialSuppliers(db,input.document,sheet.document!,{catalog:Boolean(sheet.document!.materialSupplierCatalog),publish:true});
  await validateSpecialCraftChoices(db,input.document.craftSteps??[],sheet.document?.craftSteps??[],'development');
  const deferred=Boolean(sheet.preorderPublication&&await deferredDevelopmentRoute(db,sourceId));
  const errors=developmentPublishErrors(deferred?{...input.document,customerOrderDraft:undefined}:input.document,{allowMissingOrderDate:sheet.document!.orderDate===null});if(errors.length)fail(errors.join('；'));
  if(input.affectedNodes.includes('工艺')&&input.document.craft==='无')fail('本轮没有印绣花工艺');
  if(input.affectedNodes.includes('洗水')&&input.document.washing==='免洗')fail('本轮为免洗，请核对受影响节点');
  if(input.origin!=='内部发现'&&!returnTaskId&&!patternReworkRoundId&&await developmentSlaPlan(db,sourceId)){
    await this.forms().bindFiles(db,actor,sourceId,input.document);
    return createIndependentDevelopmentRevision(db,actor,sourceId,input,undefined,directPublication);
  }
  const document=structuredClone(input.document),savedPlan=await developmentSlaPlan(db,sourceId);
  const {route,inherited,affectedNodes}=await readDevelopmentRevisionPlan(db,sourceId,input,sheet.document!,deferred?2:savedPlan?.route_schema_version);
  // A changed material gets its own identity; old arrivals never certify a replacement.
  for(const material of document.materials){const old=sheet.document!.materials.find(item=>item.materialId===material.materialId);if(old&&!sameDevelopmentMaterialBasis(old,material))material.materialId=randomUUID();}
  const roundNumber=input.basedOnRound+1,routeId=randomUUID();
  const native=await linkedDevelopmentOrder(db,sourceId,true);
  if(!patternReworkRoundId&&input.outputKind==='整件样板'&&route.includes('development_sewing')
    &&native&&['pending_confirmation','completed'].includes(native.status)){
   if(!this.patternOrders)fail('原打板执行服务未配置，不能建立没有计价依据的新制作轮');
   await this.patternOrders!.inTransaction(db).requestDevelopmentRevision(actor,native.order_id,{
    roundId:native.current_round_id,version:native.version,
    // The native reason is a short summary; revisionContext retains the full
    // accepted revision, including its 4,000-character comments.
    reason:(input.internalProblem||input.customerComment||input.explanation).slice(0,2000),
    reasonCategory:input.origin==='内部发现'?'other':input.origin==='客户新增要求'?'customer_change':'workmanship',
    attachmentIds:[],developmentNodes:affectedNodes,developmentProblems:input.categories,
   },`development-remake:${sourceId}:${roundNumber}`,{sourceId,revision:{...input,document,affectedNodes},...(returnTaskId?{returnTaskId}:{})});
   await assembleQuotation(db,sourceId,actor.actorId,undefined,rawBasis);
  return {sourceId,roundNumber};
  }
  await this.forms().bindFiles(db,actor,sourceId,document);
  await db.query(`INSERT INTO digital_development_rounds(source_id,round_number,based_on_round,document_version,document,origin,customer_comment,internal_problem,explanation,categories,affected_nodes,output_kind,route_nodes,inherited,return_task_id,route_id,created_by,published_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,[sourceId,roundNumber,input.basedOnRound,sheet.version+1,JSON.stringify(document),input.origin,input.customerComment,input.internalProblem,input.explanation,input.categories,affectedNodes,input.outputKind,route,JSON.stringify(inherited),returnTaskId??null,routeId,actor.actorId,businessNow().toISOString()]);
  const priorCycle=await technicalEnrollment(db,sourceId)?(await db.query('SELECT * FROM digital_development_cycle_rounds WHERE source_id=$1 AND round_number=$2',[sourceId,input.basedOnRound])).rows[0]:null;
  if(priorCycle)await captureTechnicalRound(db,actor.actorId,sourceId,roundNumber,businessNow().toISOString(),priorCycle.internal_wash_minutes,Number(priorCycle.warning_ratio));
  if(!affectedNodes.includes('纸样'))await inheritTechnicalArtifact(db,actor.actorId,sourceId,roundNumber,sourceId,input.basedOnRound,businessNow().toISOString());
  if(await technicalEnrollment(db,sourceId)&&!route.includes('development_pattern')&&!await publishedTechnicalArtifact(db,sourceId,roundNumber))fail('本次技术依据已改变，原成果不能沿用；请将纸样加入受影响节点后再发布，当前草稿与原轮次保持');
  if(savedPlan?.timeline_schema_version===2)await captureDevelopmentTimeline(db,actor.actorId,sourceId,roundNumber,routeId,route,document,sheet.version+1,
    `development-round:${sourceId}:${roundNumber}`,await new ContextBusinessClock(this.database,db).read({kind:'source',id:sourceId}));
  const recordPublication=async(eventId:string)=>db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,'development_round_published','digital_development',$4,$5)",[eventId,actor.requestId,actor.actorId,sourceId,JSON.stringify({roundNumber,origin:input.origin,affectedNodes,route,inherited,...(patternReworkRoundId||native?.current_round_id?{nativeRoundId:patternReworkRoundId??native!.current_round_id}:{})})]);
  if(deferred){
    const eventId=randomUUID();await recordPublication(eventId);
    await captureDeferredDevelopmentRoute(db,actor.actorId,sourceId,roundNumber,routeId,route,document,sheet.version+1,eventId,
      await new ContextBusinessClock(this.database,db).read({kind:'source',id:sourceId}));
  }
  await new DigitalProductionTaskService(this.database).supersedeSourceTasksWithClient(db,actor,sourceId,input.basedOnRound,returnTaskId);
  await new DevelopmentRouteService(this.database).startRound(db,actor,sourceId,route[0]!,routeId,roundNumber,returnTaskId);
  await new DevelopmentTechnicalService(this.database,this.enabled).ensurePositionForRound(db,actor,sourceId,roundNumber,routeId,returnTaskId);
  if(deferred||savedPlan){
    const designer=(await db.query('SELECT created_by FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0].created_by;
    await new DigitalProductionTaskService(this.database).createWithClient(db,actor,{resource:{kind:'source',id:sourceId},...(returnTaskId?{authorizingTaskId:returnTaskId}:{}),kind:'development_shipping',routeId,routeVersion:roundNumber,occurrence:roundNumber,
      assigneeId:await new DigitalProductionAccessPolicy(db).activeRole(designer,'sample_designer')?designer:null});
  }
  if(!deferred)await recordPublication(randomUUID());
  await new BulkPreparationService(this.database).syncSource(db,actor,sourceId);
  await assembleQuotation(db,sourceId,actor.actorId,undefined,rawBasis);
  return {sourceId,roundNumber};
 }
}
