import {validateSpecialCraftChoices} from './special-craft-library.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {withoutDevelopmentPrices} from './development-commercial-fields.js';
import {assembleQuotation} from './quotation-assembly.js';
import {validateAuxiliaryReferences} from '../access/auxiliary-catalog-service.js';
import {createHash,randomUUID} from "node:crypto";
import {isDeepStrictEqual} from "node:util";
import type {Pool,PoolClient} from "pg";
import {DevelopmentDocumentSchema,developmentPublishErrors,type DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import {legacyAmendmentPublicationOptions} from "./development-document-format.js";
import {DEVELOPMENT_RETURN_FIELD_LABELS,developmentReturnNeed,developmentAmendmentErrors,type DevelopmentAmendmentContext,type SaveDevelopmentAmendment,type SubmitDevelopmentAmendment} from "@dx-rework/contracts/digital-development-amendments";
import {isRootActor} from "../access/business-authority.js";
import type {TrustedActorContext} from "../tools/repositories.js";
import {ApplicationError} from "../platform/errors.js";
import {DigitalProductionAccessPolicy,digitalForbidden,digitalNotFound} from "./access-policy.js";
import {DigitalDevelopmentService} from "./development-service.js";
import {developmentAmendmentsAvailable} from "./development-amendment-repository.js";
import {developmentDirectSupplyMode,developmentSupplyRequirements,submitDevelopmentSupply} from "./development-supply.js";
import {DevelopmentRouteService} from "./development-route-service.js";
const fail=(message:string):never=>{throw new ApplicationError("DEVELOPMENT_AMENDMENT_CONFLICT",message,409);};
export class DevelopmentAmendmentService{
 constructor(private readonly database:Pool,private readonly enabled:boolean){}
 private forms(){return new DigitalDevelopmentService(this.database,this.enabled);}
 private async authorize(db:PoolClient,actor:TrustedActorContext,sourceId:string,taskId:string,write=false,requireActive=true){
  if(!this.enabled)digitalForbidden();
  if(!await developmentAmendmentsAvailable(db))fail("同轮补正服务尚未就绪，请管理员核实前后端和数据库版本");
  const sheet=await this.forms().read(actor,sourceId,db);
  const source=(await db.query("SELECT created_by FROM digital_production_sources WHERE source_id=$1",[sourceId])).rows[0]??digitalNotFound();
  const policy=new DigitalProductionAccessPolicy(db);
  if(!isRootActor(actor)&&(!actor.actorRoles.includes("sample_designer")||source.created_by!==actor.actorId||!actor.authorizationCapabilities?.includes("pattern_room:orders:create")||!(write?await policy.lockActiveRole(actor.actorId,"sample_designer"):await policy.activeRole(actor.actorId,"sample_designer"))))digitalForbidden();
  await policy.assert(actor,"task",taskId,"execute");
  const task=(await db.query("SELECT t.*,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.task_id=$2",[sourceId,taskId])).rows[0]??digitalNotFound();
  if(task.task_kind!=="development_material_supply")fail("请从我的待办打开退回的补正 / 补料任务");
  const lifecycle=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rows[0];
  if(requireActive&&lifecycle&&lifecycle.state!=="active")fail("本单已暂停或取消，请由原有权管理人处理后再补正");
  return {sheet,task};
 }
 private current(value:Awaited<ReturnType<DevelopmentAmendmentService["authorize"]>>,roundNumber:number){
  if(value.task.state!=="ready"||value.sheet.status!=="published"||value.task.route_version!==roundNumber||(value.sheet.roundNumber??1)!==roundNumber)fail("该补正任务已结束或不属于当前制作轮次，请重新打开我的待办；输入尚未覆盖正式资料");
 }
 async read(actor:TrustedActorContext,sourceId:string,taskId:string):Promise<DevelopmentAmendmentContext>{
  const db=await this.database.connect();try{
   await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
   const current=await this.authorize(db,actor,sourceId,taskId);this.current(current,current.task.route_version);
   const requirements=await developmentSupplyRequirements(db,sourceId,taskId),draft=(await db.query("SELECT * FROM digital_development_amendment_drafts WHERE source_id=$1 AND task_id=$2",[sourceId,taskId])).rows[0];
   const directSupplyMode=await developmentDirectSupplyMode(db,sourceId,taskId,requirements);
   const result={sourceId,taskId,roundNumber:current.task.route_version,documentVersion:current.sheet.version,document:current.sheet.document!,issues:requirements?.issues??[],directSupplyMode,note:requirements?.note??"旧退回记录未分项，请核对原缺项说明；补料后仍由文员复核，不会自动确认资料已补正",draft:draft?{version:draft.version,document:draft.document,reason:draft.reason}:null};
   await db.query("COMMIT");return result;
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
 private async command<T>(actor:TrustedActorContext,sourceId:string,action:string,key:string,input:SaveDevelopmentAmendment|SubmitDevelopmentAmendment,work:(db:PoolClient,current:Awaited<ReturnType<DevelopmentAmendmentService["authorize"]>>)=>Promise<T>){
  if(!/^[A-Za-z0-9._:-]{1,128}$/.test(key))fail("缺少有效操作标识，请保留输入后重新打开办理页");
  const db=await this.database.connect();try{
   await db.query("BEGIN");await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
   const current=await this.authorize(db,actor,sourceId,input.taskId,true);
   await db.query("SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE",[sourceId]);
   const command=`development-amendment:${sourceId}:${action}`,hash=createHash("sha256").update(JSON.stringify(input)).digest("hex");
   const prior=(await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3",[actor.actorId,command,key])).rows[0];
   if(prior&&prior.payload_hash!==hash)fail("同一操作标识不能用于不同补正内容");
   if(prior){await db.query("COMMIT");return prior.response as T;}
   this.current(current,input.roundNumber);
   if(current.sheet.version!==input.expectedDocumentVersion)fail("正式资料已更新，请保留输入并重新核对差异，未覆盖他人的修改");
   const quotationSource=action==='submit'?await developmentDocumentRow(db,sourceId):undefined;
   const response={...await work(db,current),originatingTaskId:input.taskId};
   if(action==='submit')await assembleQuotation(db,sourceId,actor.actorId,undefined,quotationSource);
   await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)",[actor.actorId,command,key,hash,JSON.stringify(response)]);
   await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_development',$5,$6)",[randomUUID(),actor.requestId,actor.actorId,`development_amendment_${action}`,sourceId,JSON.stringify({taskId:input.taskId,roundNumber:input.roundNumber,expectedDocumentVersion:input.expectedDocumentVersion,response})]);
   await db.query("COMMIT");return response;
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
 async save(actor:TrustedActorContext,sourceId:string,input:SaveDevelopmentAmendment,key:string){
  return this.command(actor,sourceId,"save",key,input,async(db,current)=>{
   const draft=(await db.query("SELECT version,document FROM digital_development_amendment_drafts WHERE task_id=$1 FOR UPDATE",[input.taskId])).rows[0];
   if((draft?.version??0)!==input.expectedDraftVersion)fail("补正草稿已由另一窗口更新，请保留输入后核对；没有覆盖原草稿");
   const errors=developmentAmendmentErrors(current.sheet.document!,input.document);if(errors.length)fail(errors.join("；"));
   await validateAuxiliaryReferences(db,input.document,draft?.document??current.sheet.document!);
   await this.forms().bindFiles(db,actor,sourceId,input.document);
   await db.query(`INSERT INTO digital_development_amendment_drafts(task_id,source_id,round_number,version,base_document_version,document,reason,updated_by)
    VALUES($1,$2,$3,1,$4,$5,$6,$7) ON CONFLICT(task_id) DO UPDATE SET version=digital_development_amendment_drafts.version+1,document=$5,reason=$6,updated_by=$7,updated_at=CURRENT_TIMESTAMP`,[input.taskId,sourceId,input.roundNumber,current.sheet.version,JSON.stringify(input.document),input.reason,actor.actorId]);
   return {draftVersion:input.expectedDraftVersion+1,documentVersion:current.sheet.version,roundNumber:input.roundNumber};
  });
 }
 async submit(actor:TrustedActorContext,sourceId:string,input:SubmitDevelopmentAmendment,key:string){
  return this.command(actor,sourceId,"submit",key,input,async(db,current)=>{
   const draft=(await db.query("SELECT * FROM digital_development_amendment_drafts WHERE source_id=$1 AND task_id=$2 FOR UPDATE",[sourceId,input.taskId])).rows[0];
   const requirements=await developmentSupplyRequirements(db,sourceId,input.taskId);
   const directSupplyMode=await developmentDirectSupplyMode(db,sourceId,input.taskId,requirements);
   if(!draft&&input.expectedDraftVersion===0&&directSupplyMode){
    const next=await submitDevelopmentSupply(db,this.database,actor,sourceId,input.taskId,key);
    return {...next,amendmentId:null,documentVersion:current.sheet.version,roundNumber:input.roundNumber};
   }
   if(!draft)fail("请先保存本任务的补正草稿；保存草稿不会改变正式资料");
   if(draft.version!==input.expectedDraftVersion||draft.base_document_version!==current.sheet.version||draft.round_number!==input.roundNumber)fail("补正草稿或资料版本已变化，请保留输入后重新核对");
   if(directSupplyMode&&isDeepStrictEqual(draft.document,current.sheet.document)){
    await db.query("DELETE FROM digital_development_amendment_drafts WHERE source_id=$1 AND task_id=$2",[sourceId,input.taskId]);
    const next=await submitDevelopmentSupply(db,this.database,actor,sourceId,input.taskId,key);
    return {...next,amendmentId:null,documentVersion:current.sheet.version,roundNumber:input.roundNumber};
   }
   if(!draft.reason.trim())fail("请填写本次具体补正 / 澄清说明，再保存并提交");
   const before=current.sheet.document!,document=DevelopmentDocumentSchema.parse(draft.document);
   await validateSpecialCraftChoices(db,document.craftSteps??[],before.craftSteps??[],'development');
   const errors=[...developmentAmendmentErrors(before,document),...developmentPublishErrors(document,legacyAmendmentPublicationOptions(before,document))];if(errors.length)fail(errors.join("；"));
   for(const issue of requirements?.issues??[]){
    if(developmentReturnNeed(issue)==="supply"||issue.field==="other")continue;
    const oldValue=issue.materialId?before.materials.find(m=>m.materialId===issue.materialId)?.[issue.field as keyof DevelopmentDocument["materials"][number]]:before[issue.field as keyof DevelopmentDocument];
    const nextValue=issue.materialId?document.materials.find(m=>m.materialId===issue.materialId)?.[issue.field as keyof DevelopmentDocument["materials"][number]]:document[issue.field as keyof DevelopmentDocument];
    if(isDeepStrictEqual(oldValue,nextValue))fail(`退回的${DEVELOPMENT_RETURN_FIELD_LABELS[issue.field]??"对应"}资料尚未修改，请核实该问题并保存；实物到货不能替代资料补正`);
   }
   const changes:Array<{field:string;before:unknown;after:unknown}>=[];
   for(const field of ["materials","files","instructions"] as const)if(!isDeepStrictEqual(before[field],document[field]))changes.push({field,before:before[field],after:document[field]});
   // Shipping is made ready at publication, before any making or shipment occurs.
   // Its availability alone is not execution. Preserve the making-task boundary
   // and reject actual shipping facts/completion as well as downstream execution.
   const started=(await db.query(`SELECT 1 FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    WHERE a.source_id=$1 AND t.route_version=$2 AND a.task_kind NOT IN ('development_materials','development_material_recheck','development_material_supply')
     AND (t.state='completed' OR (t.entered_at IS NOT NULL AND a.task_kind<>'development_shipping')
      OR EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id)) LIMIT 1`,[sourceId,input.roundNumber])).rowCount;
   if(changes.length&&started)fail("本轮后续工序已进入办理，补正不能改写已有制作依据、执行段或工资；请原有权人通过“实际修改 / 复版”处理影响范围");
   if(!changes.length&&requirements&&requirements.issues.every(issue=>developmentReturnNeed(issue)==="supply")){
    await db.query("DELETE FROM digital_development_amendment_drafts WHERE source_id=$1 AND task_id=$2",[sourceId,input.taskId]);
    const next=await submitDevelopmentSupply(db,this.database,actor,sourceId,input.taskId,key);
    return {...next,amendmentId:null,documentVersion:current.sheet.version,roundNumber:input.roundNumber};
   }
   // Verification basis comparison invalidates usage and all four checks when identity changes.
   await this.forms().bindFiles(db,actor,sourceId,document);
   const amendmentId=randomUUID(),documentVersion=current.sheet.version+1;
   await db.query(`INSERT INTO digital_development_amendments(amendment_id,source_id,round_number,document_version,base_document_version,task_id,draft_version,document,reason,changes,published_by)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[amendmentId,sourceId,input.roundNumber,documentVersion,current.sheet.version,input.taskId,draft.version,JSON.stringify(document),draft.reason,JSON.stringify(changes),actor.actorId]);
   await db.query("DELETE FROM digital_development_amendment_drafts WHERE source_id=$1 AND task_id=$2",[sourceId,input.taskId]);
   const next=await submitDevelopmentSupply(db,this.database,actor,sourceId,input.taskId,key);
   await new DevelopmentRouteService(this.database).releaseSewing(db,actor,sourceId);
   return {...next,amendmentId,documentVersion,roundNumber:input.roundNumber};
  });
 }
 async receipt(actor:TrustedActorContext,sourceId:string,taskId:string,operation:"save"|"submit",key:string){
  const db=await this.database.connect();try{
   await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");await this.authorize(db,actor,sourceId,taskId,false,false);
   const row=(await db.query("SELECT response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3",[actor.actorId,`development-amendment:${sourceId}:${operation}`,key])).rows[0];
   const receipt=row?.response?.originatingTaskId===taskId?row.response:null;await db.query("COMMIT");return {receipt};
  }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
 }
 async history(actor:TrustedActorContext,sourceId:string,roundNumber:number){
  const sheet=await this.forms().read(actor,sourceId,undefined,roundNumber);
  const original=(await this.database.query(roundNumber===1?"SELECT document,version,published_at FROM digital_development_documents WHERE source_id=$1":"SELECT document,document_version AS version,published_at FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2",roundNumber===1?[sourceId]:[sourceId,roundNumber])).rows[0];
  const revisions=await developmentAmendmentsAvailable(this.database)?(await this.database.query("SELECT amendment_id,document_version AS version,base_document_version,document,reason,changes,published_at,published_by FROM digital_development_amendments WHERE source_id=$1 AND round_number=$2 ORDER BY document_version",[sourceId,roundNumber])).rows:[];
  if(!sheet.canRevise)for(const row of [original,...revisions])if(row?.document?.customerOrderDraft){row.document={...row.document};delete row.document.customerOrderDraft;}
  if(!sheet.canRevise)for(const row of [original,...revisions])if(row?.document){row.document=withoutDevelopmentPrices(row.document);if(row.changes)row.changes=row.changes.map((change:{field:string;before:unknown;after:unknown})=>change.field==='materials'?{...change,before:withoutDevelopmentPrices({...row.document,materials:change.before}).materials,after:withoutDevelopmentPrices({...row.document,materials:change.after}).materials}:change);}
  return {sourceId,roundNumber,original,revisions};
 }
}
