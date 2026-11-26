import {instructionSaveReceipt} from './instruction-command-receipts.js';
import {assembleQuotation} from './quotation-assembly.js';
import {validateSpecialCraftChoices} from './special-craft-library.js';
import {readInitialTimelineInput} from './fixed-timeline-initial-input.js';
import {technicalMeasurementDocument,publishedTechnicalArtifact} from './development-technical-repository.js';
import {ProductionReadinessService} from './production-readiness-service.js';
import {preparationAdoption} from './preparation-material-repository.js';
import {productionReadiness,recordInstructionWork} from './production-readiness-repository.js';
import {businessNow} from '../acceptance-clock/business-time.js';
import {documentMetadata} from "./document-metadata.js";
import { instructionNotice } from "./instruction-notice.js";
import { PoCustomerDateService } from "./po-customer-date-service.js";
import type { InstructionDateRequest } from "@dx-rework/contracts/production-instruction";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { initialInstruction, instructionErrors, instructionMatchesTechnicalSizes, changedInstructionSourceGroups, applyInstructionSourceReview, type InstructionSourceReview, type InstructionDocument, type InstructionSheet } from "@dx-rework/contracts/production-instruction";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound } from "./access-policy.js";
import { DigitalProductionIdentityService } from "./identity-service.js";
import { developmentDocumentRow } from "./development-round-repository.js";
import {approvedOrderTimeOrder} from './order-time-admission.js';
import {automaticOrderTime} from './order-time-automatic.js';
import {acceptsNewOrderTime} from './order-time-admission.js';
import {captureWarehouseInstructionDemand,readWarehouseInstructionDemands,sourcedInstructionMaterialId} from './warehouse-instruction-demand.js';

type Database = Pick<Pool | PoolClient, "query">;
const fail = (message: string): never => { throw new ApplicationError("INSTRUCTION_CONFLICT", message, 409); };
export class ProductionInstructionService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean,private readonly transactionClient?:PoolClient) {}
  inTransaction(client:PoolClient){return new ProductionInstructionService(this.database,this.creationEnabled,client);}
  private identity = () => new DigitalProductionIdentityService(this.database, this.creationEnabled);
  private async order(db: Database, actor: TrustedActorContext, id: string, write = false) {
    const order = await this.identity().readWithClient(actor, id, db);
    const editable = isRootActor(actor) || actor.actorRoles.includes("order_merchandiser") && order.primaryMerchandiserId === actor.actorId && await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId, "order_merchandiser") || await approvedOrderTimeOrder(db,actor,id);
    if (write && !editable) digitalForbidden();
    return { order, editable };
  }
  async cutStarted(db: Database, id: string): Promise<boolean> {
    return Boolean((await db.query(`SELECT 1 FROM digital_production_child_links l JOIN cutting_orders c ON c.sourcing_case_id=l.child_id
      JOIN cutting_records r ON r.cutting_order_id=c.cutting_order_id WHERE l.module='sourcing' AND l.production_order_id=$1 LIMIT 1`, [id])).rowCount);
  }
  private async seed(db: Database, order: DigitalOrder, roundNumber?:number) {
    const document = initialInstruction(); document.sizes = [...new Set(order.lines.flatMap(line => line.sizes.map(size => size.size)))];
    const row = order.sourceId ? await developmentDocumentRow(db, order.sourceId, roundNumber) : null;
    if (!row || row.status !== "published") return { document, sourceRound: null };
    const source = (await technicalMeasurementDocument(db,order.sourceId!,row.round_number,row.document as DevelopmentDocument))?.document??row.document as DevelopmentDocument;
    document.secondaryCraft=source.craft;if(source.craftSteps)document.craftSteps=source.craftSteps; document.unit = source.unit; document.process = [source.craft === "无" ? "" : source.craft, source.washing === "免洗" ? "" : source.washing].filter(Boolean).join("／");
    document.comments = source.instructions;
    document.measurements = source.measurements.map(item => ({ id: randomUUID(), name: item.name, tolerance: "", method: "", values: document.sizes.map(size => item.values[source.sizes.indexOf(size)] ?? "") }));
    document.images = source.files.filter(file => file.kind === "款图" || file.kind === "局部图").map(file => ({ attachmentId: file.attachmentId, kind: file.kind === "款图" ? "款图" : "其它工艺", description: "" }));
    const count=new Map<string,number>();
    for(const material of source.materials)count.set(material.materialId,(count.get(material.materialId)??0)+1);
    const materialRef=(id:string)=>count.get(id)===1?sourcedInstructionMaterialId(order.productionOrderId,order.sourceId!,id):randomUUID();
    document.fabrics = source.materials.filter(item => item.category !== "辅料").map(item => ({ id: materialRef(item.materialId), name: item.name, part: item.label, colors: Object.fromEntries(order.lines.map(line => [line.lineId, item.color])), remarks: [item.width, item.weight, item.composition].filter(Boolean).join("／") }));
    document.accessories = source.materials.filter(item => item.category === "辅料").map(item => ({ id: materialRef(item.materialId), group: "车缝", garmentColors: order.lines.map(line => line.color).join("、"), materialColor: item.color, name: item.name, category: "", part: item.label, specification: item.specification, consumption: item.consumption, remarks: "" }));
    document.composition = source.materials.filter(item => item.category === "主布").map(item => item.composition).filter(Boolean).join("／");
    return { document, sourceRound: row.round_number ?? 1, sourceVersion:row.version as number };
  }
  async read(actor: TrustedActorContext, id: string, db: Database = this.database, version?: number,original=false): Promise<InstructionSheet> {
    const { order, editable } = await this.order(db, actor, id);
    const cutStarted = await this.cutStarted(db, id);
    const draftAccess=editable&&!cutStarted;
    const published=(await db.query("SELECT published_version FROM digital_instruction_documents WHERE production_order_id=$1",[id])).rows[0]?.published_version??null;
    const selectedVersion=version??(!draftAccess?published:null);
    const row = !draftAccess&&!selectedVersion?undefined:(await db.query(selectedVersion ? "SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 AND version=$2" : "SELECT * FROM digital_instruction_documents WHERE production_order_id=$1", selectedVersion ? [id, selectedVersion] : [id])).rows[0];
    if (version && !row) digitalNotFound();
    const seeded = row ? { document: row.document, sourceRound: row.source_round } : draftAccess?await this.seed(db, order):{document:initialInstruction(),sourceRound:null};
    const name = order.primaryMerchandiserId ? (await db.query("SELECT display_name FROM app_users WHERE id=$1", [order.primaryMerchandiserId])).rows[0]?.display_name ?? null : null;
    const dates = await new PoCustomerDateService(this.database).read(actor, id, db);
    const latestSourceRound=order.sourceId?(await developmentDocumentRow(db,order.sourceId))?.round_number??null:null;
    let sourceComparison:InstructionSheet["sourceComparison"];
    if(draftAccess&&!selectedVersion&&latestSourceRound&&seeded.sourceRound!==latestSourceRound){
      const before=seeded.sourceRound?await this.seed(db,order,seeded.sourceRound):{document:initialInstruction()};
      const proposed=await this.seed(db,order,latestSourceRound);
      if(proposed.sourceRound&&proposed.sourceVersion)sourceComparison={sourceRound:proposed.sourceRound,sourceVersion:proposed.sourceVersion,before:before.document,proposed:proposed.document,groups:changedInstructionSourceGroups(before.document,proposed.document)};
    }
    const review=(await db.query("SELECT a.after_state,a.created_at,u.display_name FROM audit_events a LEFT JOIN app_users u ON u.id=a.actor_id WHERE a.entity_type='digital_instruction' AND a.entity_id=$1 AND a.action='instruction_source_decisions' AND (a.after_state->>'version')::int<=$2 ORDER BY a.created_at DESC LIMIT 1",[id,row?.version??0])).rows[0];
    const sourceReview:InstructionSheet["sourceReview"]=review?{sourceRound:review.after_state.sourceRound,...(typeof review.after_state.sourceVersion==='number'?{sourceVersion:review.after_state.sourceVersion}:{}),instructionVersion:review.after_state.version,decisions:review.after_state.decisions,reviewedAt:new Date(review.created_at).toISOString(),reviewedBy:review.display_name??"",...(review.after_state.priorMeasurements?{priorMeasurements:review.after_state.priorMeasurements}:{})}:undefined;
    const technicalTable=!original&&order.sourceId&&latestSourceRound?(await publishedTechnicalArtifact(db,order.sourceId,latestSourceRound))?.artifact.body.baseSizeTable:null;
    return { orderTimeEnabled:await acceptsNewOrderTime(db),...(await readInitialTimelineInput(db,{kind:'order',id})?{timelineSchemaVersion:2 as const}:{}),...(technicalTable?{technicalSizeTable:technicalTable}:{}),...(!original&&await preparationAdoption(db,{kind:'order',id})?{readiness:await new ProductionReadinessService(this.database).read(actor,{kind:'order',id},db)}:{}), metadata:await documentMetadata(db,row), order: original&&selectedVersion?row.order_snapshot:selectedVersion ? {...row.order_snapshot,lines:(row.order_snapshot as DigitalOrder).lines.map(line=>{const current=order.lines.find(l=>l.lineId===line.lineId);return current?{...line,poNumber:current.poNumber,formalStyleNo:current.formalStyleNo,temporaryStyleNo:current.temporaryStyleNo}:line;})} : order, currentOrderVersion:order.version,currentDeliveryDate:order.contractDeliveryDate, document: seeded.document, version: row?.version ?? 0,
      publishedVersion: selectedVersion ?? published, isPublishedSnapshot:Boolean(selectedVersion), sourceRound: seeded.sourceRound, latestSourceRound, ...(sourceComparison?{sourceComparison}:{}),...(sourceReview?{sourceReview}:{}),
      versions: (await db.query("SELECT version FROM digital_instruction_versions WHERE production_order_id=$1 ORDER BY version DESC", [id])).rows.map(r => r.version),
      canEdit: draftAccess && !version && (Boolean(row) || this.creationEnabled), cutStarted, merchandiserName: name,
      ...dates, printedBy: (await db.query("SELECT display_name FROM app_users WHERE id=$1",[actor.actorId])).rows[0]?.display_name ?? "" };
  }
  private async command<T>(actor: TrustedActorContext, id: string, action: string, key: string, input: unknown, work: (db: PoolClient, order: DigitalOrder) => Promise<T>, leader = false, rejectingDate = false): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识");
    const db = this.transactionClient??await this.database.connect();
    try {
      if(!this.transactionClient)await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [id]);
      const { order } = await this.order(db, actor, id, !leader);
      if (leader && !isRootActor(actor) && !actor.actorRoles.includes("production_management")) digitalForbidden();
      const command = `instruction:${id}:${action}`, hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = (await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key])).rows[0];
      if (prior && prior.payload_hash !== hash) fail("操作标识已用于不同内容");
      if (prior) { if(!this.transactionClient)await db.query("COMMIT"); return prior.response; }
      const state = (await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1", [id])).rows[0]?.state;
      if (!rejectingDate && state && state !== "active") fail("母单已暂停或取消");
      if (!rejectingDate && await this.cutStarted(db, id)) fail("已经开裁，不能实质修改制单；编号请从母单补齐");
      const result = await work(db,order);
      await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(result)]);
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_instruction',$5,$6)", [randomUUID(), actor.requestId, actor.actorId, action, id, JSON.stringify({ action, version: (result as InstructionSheet).version })]);
      if(!this.transactionClient)await db.query("COMMIT"); return result;
    } catch (error) { if(!this.transactionClient)await db.query("ROLLBACK"); throw error; } finally { if(!this.transactionClient)db.release(); }
  }
  private async lockImageBindings(db: PoolClient, actor: TrustedActorContext, order: DigitalOrder, document: InstructionDocument) {
    const source = order.sourceId ? await developmentDocumentRow(db, order.sourceId) : null;
    const permitted = source?.status === "published" ? (source.document as DevelopmentDocument).files.filter(file => ["款图", "局部图", "工艺开发板"].includes(file.kind)).map(file => file.attachmentId) : [];
    const bindings: {attachmentId:string;claim:boolean}[]=[];
    for (const attachmentId of [...new Set(document.images.map(image=>image.attachmentId))].sort((a,b)=>a.localeCompare(b))) {
      const row = (await db.query("SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE", [attachmentId])).rows[0];
      if (!row || row.status !== "ready" || !["image/jpeg", "image/png", "image/webp"].includes(row.mime_type)) fail("制单图片须为已上传完成的 JPG、PNG 或 WebP");
      const bound = (await db.query("SELECT 1 FROM digital_instruction_attachment_bindings WHERE production_order_id=$1 AND attachment_id=$2", [order.productionOrderId, attachmentId])).rowCount;
      const claim=!bound&&!(row.entity_type === "digital_development" && row.entity_id === order.sourceId && permitted.includes(attachmentId));
      if(claim&&(row.entity_type||row.uploaded_by!==actor.actorId))digitalForbidden();
      bindings.push({attachmentId,claim});
    }
    return async()=>{
      for(const {attachmentId,claim} of bindings){
        if(claim)await db.query("UPDATE attachments SET entity_type='digital_instruction',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1",[attachmentId,order.productionOrderId]);
        await db.query("INSERT INTO digital_instruction_attachment_bindings(production_order_id,attachment_id) VALUES($1,$2) ON CONFLICT DO NOTHING",[order.productionOrderId,attachmentId]);
      }
    };
  }
  private async bindImages(db: PoolClient, actor: TrustedActorContext, order: DigitalOrder, document: InstructionDocument) {
    const bind=await this.lockImageBindings(db,actor,order,document);
    await bind();
  }
  async save(actor: TrustedActorContext, id: string, input: { expectedVersion: number; orderVersion: number; document: InstructionDocument;sourceRound?:number|null|undefined }, key: string) {
    return this.command(actor,id,"save",key,input,async(db,order) => {
      const current = await this.read(actor,id,db);
      if (!current.canEdit || current.version !== input.expectedVersion || order.version !== input.orderVersion) fail("母单或制单已更新，请重新打开");
      if(current.version===0&&order.sourceId&&input.sourceRound===undefined)fail("首次保存请确认采用的开发轮次");
      if(current.version===0&&input.sourceRound!==undefined&&input.sourceRound!==current.sourceRound)fail("开发资料已更新，请重新读取初始制单后核对");
      await validateSpecialCraftChoices(db,input.document.craftSteps??[],current.document.craftSteps??[],'bulk');
      await this.bindImages(db,actor,order,input.document);
      await db.query(`INSERT INTO digital_instruction_documents(production_order_id,version,order_version,document,source_round,updated_by) VALUES($1,1,$2,$3,$4,$5)
        ON CONFLICT(production_order_id) DO UPDATE SET version=digital_instruction_documents.version+1,order_version=EXCLUDED.order_version,document=EXCLUDED.document,source_round=EXCLUDED.source_round,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`, [id,order.version,JSON.stringify(input.document),current.sourceRound,actor.actorId]);
      await recordInstructionWork(db,actor.actorId,id,'draft_saved',current.version+1);
      return this.read(actor,id,db);
    });
  }
  async reviewSource(actor:TrustedActorContext,id:string,input:InstructionSourceReview,key:string){
    return this.command(actor,id,"source_review",key,input,async(db,order)=>{
      const current=await this.read(actor,id,db),comparison=current.sourceComparison;
      if(!current.canEdit||current.version!==input.expectedVersion||order.version!==input.orderVersion)fail("母单或制单已更新，请重新核对");
      if(!comparison)return fail("开发资料已变化，请重新核对最新资料");
      if(comparison.sourceRound!==input.sourceRound||comparison.sourceVersion!==input.sourceVersion)fail("开发资料已变化，请重新核对最新资料");
      if(input.decisions.length!==comparison.groups.length||new Set(input.decisions.map(item=>item.group)).size!==input.decisions.length||input.decisions.some(item=>!comparison.groups.includes(item.group)))fail("请逐项选择采用新值或保留本单原值");
      let document:InstructionDocument;
      try{document=applyInstructionSourceReview(input.document,comparison.proposed,input.decisions,comparison.before);}catch{return fail("核对后的资料超出制单限制或尺码不一致，请调整后重试");}
      await validateSpecialCraftChoices(db,document.craftSteps??[],current.document.craftSteps??[],'bulk');
      await this.bindImages(db,actor,order,document);
      await db.query(`INSERT INTO digital_instruction_documents(production_order_id,version,order_version,document,source_round,updated_by) VALUES($1,1,$2,$3,$4,$5)
        ON CONFLICT(production_order_id) DO UPDATE SET version=digital_instruction_documents.version+1,order_version=EXCLUDED.order_version,document=EXCLUDED.document,source_round=EXCLUDED.source_round,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`,[id,order.version,JSON.stringify(document),comparison.sourceRound,actor.actorId]);
      const priorMeasurements=input.document.unit!==document.unit?{unit:input.document.unit,sizes:input.document.sizes,measurements:input.document.measurements}:undefined;
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state) VALUES($1,$2,$3,'instruction_source_decisions','digital_instruction',$4,$5,$6)",[randomUUID(),actor.requestId,actor.actorId,id,JSON.stringify({sourceRound:current.sourceRound,version:current.version}),JSON.stringify({sourceRound:comparison.sourceRound,sourceVersion:comparison.sourceVersion,version:current.version+1,decisions:input.decisions,...(priorMeasurements?{priorMeasurements}:{})})]);
      return this.read(actor,id,db);
    });
  }
  async publish(actor: TrustedActorContext,id:string,input:{expectedVersion:number;orderVersion:number;expectedReadinessRevision?:string|undefined},key:string) {
    return this.command(actor,id,"publish",key,input,async(db,order) => {
      const current=await this.read(actor,id,db);
      if (!current.canEdit || !current.version || current.version!==input.expectedVersion || order.version!==input.orderVersion) fail("母单或制单已更新，请重新打开");
      if(current.publishedVersion===current.version)return current;
      const previous=current.publishedVersion?(await db.query('SELECT document FROM digital_instruction_versions WHERE production_order_id=$1 AND version=$2',[id,current.publishedVersion])).rows[0]?.document as InstructionDocument|undefined:undefined;
      if(current.document.craftSteps?.some(step=>step.craftKind==='special')){
       const inherited=await this.seed(db,order,current.sourceRound??undefined);
       await validateSpecialCraftChoices(db,current.document.craftSteps,[...(previous?.craftSteps??[]),...(inherited.document.craftSteps??[])],'bulk');
      }
      if(current.sourceRound!==current.latestSourceRound)fail("开发单有新资料，请逐项核对采用或保留后发布");
      const readiness=await productionReadiness(db,id);
      let warehouseDemand:ReturnType<typeof captureWarehouseInstructionDemand>=null;
      if(readiness.adoption){if(input.expectedReadinessRevision!==readiness.revision)fail('产前依据已变化，请刷新并核对当前有效资料');if(readiness.finalReasons.length)fail(readiness.finalReasons.join('；'));
       const technical=(await publishedTechnicalArtifact(db,order.sourceId!,current.sourceRound!))!.artifact;
       if(!instructionMatchesTechnicalSizes(current.document,order,technical.body.baseSizeTable))fail('制单尺寸与当前有效技术尺寸表不一致，请明确采用技术表；缺订购尺码须由技术补充复核');
       if(readiness.document&&technical.artifactSetId===readiness.technical?.artifactRef?.id&&technical.version===readiness.technical.artifactRef.version){
        const inherited=await this.seed(db,order,current.sourceRound!);
        const previousTracked=current.publishedVersion?(await readWarehouseInstructionDemands(db,[id])).get(id)?.demand.tracked:undefined;
        warehouseDemand=captureWarehouseInstructionDemand({order,round:current.sourceRound!,document:current.document,inherited:inherited.document,
         materials:(readiness.document.document as DevelopmentDocument).materials,artifact:technical,...(previousTracked?{previousTracked}:{})});
       }
      }
      const issues=instructionErrors(current.document,order);if(issues.length)fail(issues.join("；"));
      const bind=await this.lockImageBindings(db,actor,order,current.document);
      const operation={kind:'instruction_publish' as const,orderId:id,input:{expectedVersion:input.expectedVersion,orderVersion:input.orderVersion,
        ...(input.expectedReadinessRevision!==undefined?{expectedReadinessRevision:input.expectedReadinessRevision}:{})}};
      return automaticOrderTime(this.database,db,actor,operation,async()=>{
        await bind();
        await db.query("INSERT INTO digital_instruction_versions(production_order_id,version,order_version,document,order_snapshot,source_round,published_by,published_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",[id,current.version,order.version,JSON.stringify(current.document),JSON.stringify(order),current.sourceRound,actor.actorId,businessNow().toISOString()]);
        await db.query("UPDATE digital_instruction_documents SET published_version=version WHERE production_order_id=$1",[id]);
        if(readiness.adoption)await db.query('INSERT INTO digital_instruction_preparation_bases(production_order_id,instruction_version,readiness_revision,technical_revision,basis_json) VALUES($1,$2,$3,$4,$5)',[id,current.version,readiness.revision,readiness.technical!.revision,JSON.stringify({artifact:readiness.technical!.artifactRef,review:readiness.technical!.reviewRef,comment:readiness.technical!.finalCommentRef,...(warehouseDemand?{warehouseDemand}:{})})]);
        await recordInstructionWork(db,actor.actorId,id,'published',current.version,{technicalRevision:readiness.technical?.revision??null});
        await instructionNotice(db,order,current.version,"大货制单已发布",`instruction:${id}:${current.version}`);
        await new BulkPreparationService(this.database).sync(db,actor,id);
        if(order.sourceId&&(current.document.craftSteps?.some(step=>step.craftKind==='special')||previous?.craftSteps?.some(step=>step.craftKind==='special')||(await developmentDocumentRow(db,order.sourceId))?.document?.craftSteps?.some((step:{craftKind:string})=>step.craftKind==='special')))await assembleQuotation(db,order.sourceId,actor.actorId);
        return this.read(actor,id,db);
      });
    });
  }
  async requestDate(actor:TrustedActorContext,id:string,input:InstructionDateRequest,key:string){
    await new PoCustomerDateService(this.database).request(actor,id,input,key);
    return this.read(actor,id);
  }
  async decisionReceipt(actor:TrustedActorContext,id:string,requestId:string,approved:boolean,key:string){return new PoCustomerDateService(this.database).decisionReceipt(actor,id,requestId,approved,key);}
  async saveReceipt(actor:TrustedActorContext,id:string,key:string){return instructionSaveReceipt(this.database,actor,id,key);}
  async decideDate(actor:TrustedActorContext,id:string,requestId:string,approved:boolean,key:string){
    await new PoCustomerDateService(this.database).decide(actor,id,requestId,approved,key);
    try{return await this.read(actor,id);}catch(cause){
      const error=new ApplicationError('PO_CUSTOMER_DECISION_READ_UNAVAILABLE','原改期决定已返回，当前制单资料读取失败；请只读核对原决定回执',503);
      Object.defineProperty(error,'cause',{value:cause});throw error;
    }
  }
  async legacyDateGuard(db: PoolClient, id: string) {
    if (!(await db.query("SELECT to_regclass('digital_instruction_documents') AS relation")).rows[0]?.relation) return false;
    const state=(await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1",[id])).rows[0]?.state;
    if(state && state!=="active")fail("母单已暂停或取消");
    if(await this.cutStarted(db,id))fail("已经开裁，不能实质修改客户交付期");
    return true;
  }
  async legacyDateNotice(db: PoolClient, actor: TrustedActorContext, id: string, title: string, key: string, directorsOnly=false) {
    if (!(await db.query("SELECT to_regclass('digital_instruction_notices') AS relation")).rows[0]?.relation) return;
    await instructionNotice(db,await this.identity().readWithClient(actor,id,db),null,title,key,directorsOnly);
  }
  async authorizeUpload(actor:TrustedActorContext,id:string){const current=await this.read(actor,id);if(!current.canEdit)digitalForbidden();}
  async originalVersions(actor:TrustedActorContext,id:string,page:number,q:string){
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');await this.order(db,actor,id);
      const row=(await db.query(`WITH matching AS (SELECT version,published_at,source_round FROM digital_instruction_versions WHERE production_order_id=$1 AND ($2::text='' OR strpos(lower('大货制单 已发布版本 '||version),lower($2))>0)),
       chosen AS (SELECT * FROM matching ORDER BY version DESC LIMIT 15 OFFSET $3)
       SELECT (SELECT count(*)::int FROM matching) AS total,COALESCE(jsonb_agg(jsonb_build_object('version',version,'publishedAt',published_at,'sourceRound',source_round) ORDER BY version DESC),'[]'::jsonb) AS items FROM chosen`,[id,q,(page-1)*15])).rows[0]!;
      await db.query('COMMIT');return {id,page,pageSize:15,total:row.total,items:row.items};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async originalVersion(actor:TrustedActorContext,id:string,version:number){
    const db=await this.database.connect();
    try{
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const sheet=await this.read(actor,id,db,version,true);
      const row=(await db.query('SELECT order_snapshot FROM digital_instruction_versions WHERE production_order_id=$1 AND version=$2',[id,version])).rows[0]??digitalNotFound();
      // Keep the saved PO/style identities. The normal historical reader's
      // current-label overlay remains unchanged for its existing consumers.
      const saved={...sheet};delete saved.technicalSizeTable;delete saved.sourceComparison;delete saved.readiness;
      await db.query('COMMIT');return {...saved,order:row.order_snapshot as DigitalOrder,canEdit:false};
    }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
  }
  async canDownloadOriginal(actor:TrustedActorContext,id:string,version:number,attachmentId:string){
    const sheet=await this.originalVersion(actor,id,version);
    return sheet.document.images.some(image=>image.attachmentId===attachmentId)&&this.canDownload(actor,id,attachmentId);
  }
  async canDownload(actor:TrustedActorContext,id:string,attachmentId:string){
    const current=await this.read(actor,id);
    if(current.canEdit){
      if((await this.database.query("SELECT 1 FROM digital_instruction_attachment_bindings WHERE production_order_id=$1 AND attachment_id=$2",[id,attachmentId])).rowCount)return true;
      return current.document.images.some(image=>image.attachmentId===attachmentId)||Boolean(current.sourceComparison&&[...current.sourceComparison.before.images,...current.sourceComparison.proposed.images].some(image=>image.attachmentId===attachmentId));
    }
    return Boolean((await this.database.query("SELECT 1 FROM digital_instruction_versions v CROSS JOIN LATERAL jsonb_array_elements(v.document->'images') image WHERE v.production_order_id=$1 AND image->>'attachmentId'=$2 LIMIT 1",[id,attachmentId])).rowCount);
  }
}
