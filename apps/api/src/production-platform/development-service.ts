import {developmentRevisionSource,inheritedDevelopmentFile} from './development-revision-source.js';
import {acceptanceBusinessContext,observedBusinessTime,businessNow} from '../acceptance-clock/business-time.js';
import {validateAuxiliaryReferences} from '../access/auxiliary-catalog-service.js';
import {DevelopmentAmendmentService} from "./development-amendment-service.js";
import {developmentDraftForSave} from "./development-document-format.js";
import type {SaveDevelopmentAmendment,SubmitDevelopmentAmendment} from "@dx-rework/contracts/digital-development-amendments";
import {effectiveVerificationDocument} from "./development-material-verification.js";
import {documentMetadata} from "./document-metadata.js";
import {materialReadiness} from "./development-material-readiness.js";
import { beijingCalendarDate } from "@dx-rework/contracts/digital-production";
import {developmentDocumentRow,developmentRoundsAvailable} from "./development-round-repository.js";
import {DevelopmentRouteService} from "./development-route-service.js";
import type {PatternRoomOrderService} from "../pattern-room/order-service.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { developmentPublishErrors, type DevelopmentDocument, type DevelopmentMaterialEvent, type DevelopmentSheet } from "@dx-rework/contracts/digital-development";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound } from "./access-policy.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { captureDevelopmentSla, developmentSlaPlan,developmentSlaRoute } from "./development-sla-enrollment.js";
import {developmentOccurrence} from './development-occurrence.js';
import {captureDevelopmentTimeline} from './fixed-development-adoption.js';
import type { BusinessClock } from "@dx-rework/domain/business-clock";
import {approvedOrderTimeSource,acceptsNewOrderTime} from './order-time-admission.js';
import {automaticOrderTime} from './order-time-automatic.js';
import {assembleQuotation} from './quotation-assembly.js';
import {withoutDevelopmentPrices} from './development-commercial-fields.js';

type Database = Pick<Pool | PoolClient, "query">;
const conflict = (message: string): never => { throw new ApplicationError("DEVELOPMENT_CONFLICT", message, 409); };
export class DigitalDevelopmentService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean, private readonly patternOrders?:PatternRoomOrderService, private readonly now:()=>Date=()=>new Date(), private readonly businessClock?:BusinessClock,private readonly transactionClient?:PoolClient) {}
  inTransaction(client:PoolClient){return new DigitalDevelopmentService(this.database,this.creationEnabled,this.patternOrders,this.now,this.businessClock,client);}
  private async source(db: Database, actor: TrustedActorContext, sourceId: string, write = false) {
    const source = (await db.query("SELECT s.*,u.display_name AS designer_name FROM digital_production_sources s JOIN app_users u ON u.id=s.created_by WHERE s.source_id=$1", [sourceId])).rows[0] ?? digitalNotFound();
    const owner = isRootActor(actor) || (actor.actorRoles.includes("sample_designer") && source.created_by === actor.actorId && (actor.authorizationCapabilities ?? []).includes("pattern_room:orders:create")) || await approvedOrderTimeSource(db,actor,sourceId);
    if (write) { if (!this.creationEnabled || !owner) digitalForbidden(); }
    else if (!await new DigitalProductionAccessPolicy(db).allowed(actor, "source", sourceId, "technical")) {
      const tasks = (await db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1", [sourceId])).rows;
      let visible = false;
      for (const task of tasks) if (await new DigitalProductionAccessPolicy(db).allowed(actor, "task", task.task_id, "technical")) { visible = true; break; }
      if (!visible) digitalNotFound();
    }
    return { ...source, can_edit: owner && this.creationEnabled, can_view_order_draft: owner };
  }
  async authorizeUpload(actor: TrustedActorContext, sourceId: string) { await this.source(this.database, actor, sourceId, true); }
  async authorizeAttachmentRead(actor:TrustedActorContext,sourceId:string){await this.source(this.database,actor,sourceId);}
  async canDownload(actor: TrustedActorContext, sourceId: string, attachmentId: string): Promise<boolean> {
    await this.source(this.database, actor, sourceId);
    return Boolean((await this.database.query("SELECT 1 FROM digital_development_attachment_bindings WHERE source_id=$1 AND attachment_id=$2", [sourceId, attachmentId])).rowCount)||await inheritedDevelopmentFile(this.database,sourceId,attachmentId);
  }
  async read(actor: TrustedActorContext, sourceId: string, db: Database = this.database, roundNumber?: number): Promise<DevelopmentSheet> {
    const source = await this.source(db, actor, sourceId);
    const adoptedPlan=await developmentSlaPlan(db,sourceId);
    const row = await developmentDocumentRow(db,sourceId,roundNumber);
    const rounds=await developmentRoundsAvailable(db);
    if(roundNumber&&!row)digitalNotFound();
    const materialEvents = (await db.query(`SELECT m.event_id AS "eventId",m.material_id AS "materialId",m.action,m.expected_date::text AS "expectedDate",m.note,m.created_at AS "createdAt",
      e.occurred_at AS "occurredAt",e.payload->>'actualCompletedDate' AS "occurredDate",e.time_quality AS "timeQuality"
      FROM digital_development_material_events m LEFT JOIN digital_production_task_events e ON e.event_id=m.event_id
       AND e.resource_kind='source' AND e.resource_id=m.source_id AND e.event_kind='development_material_recorded'
      WHERE m.source_id=$1 ${rounds?"AND m.route_version=$2":""} ORDER BY m.sequence`, rounds?[sourceId,row?.round_number??1]:[sourceId])).rows;
    const productionOrderId=source.can_view_order_draft?(await db.query("SELECT production_order_id FROM digital_production_orders WHERE source_id=$1",[sourceId])).rows[0]?.production_order_id??null:null;
    let document=row?.document??null;
    if(document?.customerOrderDraft&&!source.can_view_order_draft){document={...document};delete document.customerOrderDraft;}
    if(document&&!source.can_view_order_draft)document=withoutDevelopmentPrices(document);
    const effectiveMaterials=row?.status==="published"&&(await db.query("SELECT to_regclass('digital_development_execution_facts') AS relation")).rows[0]?.relation?(await materialReadiness(db,sourceId,row.round_number??1)).materials:[];
    const createdTime=source.order_time_managed?(await db.query('SELECT created_business_time FROM digital_order_time_subjects WHERE source_id=$1',[sourceId])).rows[0]?.created_business_time?.now
      :acceptanceBusinessContext()?(await db.query('SELECT business_time FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision LIMIT 1',[sourceId])).rows[0]?.business_time?.now:null;
    return { orderTimeEnabled:Boolean(source.order_time_managed)||await acceptsNewOrderTime(db),...(adoptedPlan?.timeline_schema_version===2?{timelineSchemaVersion:2 as const}:{}),revisionSource:await developmentRevisionSource(db,sourceId),independentRevisions:Boolean(adoptedPlan),developmentCreatedDate:beijingCalendarDate(new Date(createdTime??source.created_at)), metadata:await documentMetadata(db,row?.revision??row), materialReadiness:effectiveMaterials, sourceId, productionOrderId, designStyleNo: source.design_style_no, temporaryStyleNo: source.temporary_style_no, customerCode: source.customer_code,
      developmentType: source.development_type, designerName: source.designer_name, version: row?.version ?? 0, status: row?.status ?? "draft",
      document, publishedAt: row?.published_at ? new Date(row.published_at).toISOString() : null, taskId: row?.task_id ?? null,
      canRevise:source.can_edit,roundNumber:row?.round_number??1,latestRoundNumber:row?.latest_round_number??1,canEdit: source.can_edit && (!row || row.round_number===row.latest_round_number), materialEvents };
  }
  private async command<T>(actor: TrustedActorContext, sourceId: string, command: string, key: string, input: unknown, action: (db: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) conflict("缺少有效操作标识");
    const db = this.transactionClient??await this.database.connect();
    try {
      if(!this.transactionClient)await db.query("BEGIN");
      // Same ordering as task adapters: lifecycle lock before source/attachment locks.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await this.source(db, actor, sourceId, true);
      await db.query("SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE", [sourceId]);
      const name = `development:${sourceId}:${command}`;
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = (await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, name, key])).rows[0];
      if (prior && prior.payload_hash !== hash) conflict("同一操作标识不能用于不同内容");
      const quotationSource=!prior&&(command==='save'||command==='publish')?await developmentDocumentRow(db,sourceId):undefined;
      const result = prior ? prior.response as T : await action(db);
      if (!prior) {
        if(command==='save'||command==='publish')await assembleQuotation(db,sourceId,actor.actorId,undefined,quotationSource);
        await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, name, key, hash, JSON.stringify(result)]);
        await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_development',$5,$6)", [randomUUID(), actor.requestId, actor.actorId, `development_${command}`, sourceId, JSON.stringify({ command, version: (result as { version?: number }).version })]);
      }
      if(!this.transactionClient)await db.query("COMMIT"); return result;
    } catch (error) { if(!this.transactionClient)await db.query("ROLLBACK"); throw error; } finally { if(!this.transactionClient)db.release(); }
  }
  async bindFiles(db: PoolClient, actor: TrustedActorContext, sourceId: string, document: DevelopmentDocument) {
    for (const file of [...document.files].sort((a,b) => a.attachmentId.localeCompare(b.attachmentId))) {
      const row = (await db.query("SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE", [file.attachmentId])).rows[0];
      if (!row || row.status !== "ready" || !["image/jpeg","image/png","image/webp","application/pdf"].includes(row.mime_type)) conflict("附件必须是已上传完成的图片或 PDF");
      if (["款图","局部图"].includes(file.kind) && !row.mime_type.startsWith("image/")) conflict("款图和局部图请使用图片");
      if(await inheritedDevelopmentFile(db,sourceId,file.attachmentId))continue;
      if (row.entity_type ? row.entity_type !== "digital_development" || row.entity_id !== sourceId : row.uploaded_by !== actor.actorId) digitalForbidden();
      await db.query("UPDATE attachments SET entity_type='digital_development',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [file.attachmentId, sourceId]);
      await db.query("INSERT INTO digital_development_attachment_bindings(attachment_id,source_id,bound_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [file.attachmentId, sourceId, actor.actorId]);
    }
  }
  async save(actor: TrustedActorContext, sourceId: string, input: { expectedVersion: number; document: DevelopmentDocument }, key: string) {
    return this.command(actor, sourceId, "save", key, input, async db => {
      const row = (await db.query("SELECT version,status,document FROM digital_development_documents WHERE source_id=$1", [sourceId])).rows[0];
      if ((row?.version ?? 0) !== input.expectedVersion) conflict("开发单已更新，请重新打开后再保存");
      if (row?.status === "published") conflict("已发布开发单不可覆盖，请通过复版记录实际修改");
      const source=(await db.query("SELECT created_at FROM digital_production_sources WHERE source_id=$1",[sourceId])).rows[0];
      const sourceDate=acceptanceBusinessContext()?(await db.query('SELECT business_time FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision LIMIT 1',[sourceId])).rows[0]?.business_time?.now??source.created_at:source.created_at;
      const document=developmentDraftForSave(input.document,row?.document,sourceDate);
      if(document.customerOrderDraft?.withOrder&&await developmentRevisionSource(db,sourceId))conflict('复版沿原开发档案的客户订单，不重复填写大货数量');
      await validateAuxiliaryReferences(db,document,row?.document);
      await this.bindFiles(db, actor, sourceId, document);
      await db.query(`INSERT INTO digital_development_documents(source_id,version,status,document,updated_by) VALUES($1,1,'draft',$2,$3)
        ON CONFLICT(source_id) DO UPDATE SET version=digital_development_documents.version+1,document=EXCLUDED.document,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`, [sourceId, JSON.stringify(document), actor.actorId]);
      return this.read(actor, sourceId, db);
    });
  }
  async publish(actor: TrustedActorContext, sourceId: string, expectedVersion: number, key: string, patternOrder?:{categoryId:string;priceVersion:number}) {
    return this.command(actor, sourceId, "publish", key, { expectedVersion,...(patternOrder?{patternOrder}:{}) }, async db => {
      const row = (await db.query("SELECT * FROM digital_development_documents WHERE source_id=$1", [sourceId])).rows[0] ?? conflict("请先保存开发单");
      if (row.status === "published") { if (row.version === expectedVersion + 1) return this.read(actor, sourceId, db); conflict("开发单已经发布"); }
      if (row.version !== expectedVersion) conflict("开发单已更新，请重新打开后发布");
      const errors = developmentPublishErrors(row.document);
      if (errors.length) throw new ApplicationError("VALIDATION_ERROR", errors.join("；"), 400);
      if(row.document.customerOrderDraft?.withOrder){
        // This is development publication, not formal PO confirmation. Preserve incomplete
        // ordering data for the later strict createOrder command without inventing sizes.
        const draft=row.document.customerOrderDraft.order;
        const source=(await db.query("SELECT design_style_no,temporary_style_no,customer_code FROM digital_production_sources WHERE source_id=$1",[sourceId])).rows[0];
        if(source.design_style_no!==draft.designStyleNo||(source.temporary_style_no??"")!==(draft.temporaryStyleNo??"")||(source.customer_code&&source.customer_code!==draft.customerCode))
          throw new ApplicationError("VALIDATION_ERROR","订购草稿的款号、代用款号及客户须与当前开发来源一致",400);
      }
      const craftPiece=(await developmentRevisionSource(db,sourceId))?.outputKind==='工艺布片';
      if(this.patternOrders&&!patternOrder&&!craftPiece)conflict("请先选择有效打板品类与执行价，再正式提交开发单");
      if(patternOrder&&craftPiece)conflict('工艺布片不建立整件车板执行，请刷新本单');
      if(patternOrder&&!this.patternOrders)conflict("打板执行衔接服务未配置");
      await this.bindFiles(db, actor, sourceId, row.document);
      return automaticOrderTime(this.database,db,actor,{kind:'development_publish',sourceId,input:{expectedVersion,...(patternOrder?{patternOrder}:{})}},async()=>{
      const time = this.businessClock ? await this.businessClock.read({ kind: "source", id: sourceId })
        : observedBusinessTime(this.now);
      // Only sources enrolled at creation receive the new rules. Publishing a legacy draft is not enrollment.
      if (await developmentSlaPlan(db, sourceId)||(await db.query("SELECT to_jsonb(s)->>'order_time_managed' AS managed FROM digital_production_sources s WHERE source_id=$1",[sourceId])).rows[0]?.managed==='true') await captureDevelopmentSla(db, actor, sourceId, row.document, time, `development-publish:${sourceId}:${key}`);
      const routeId=randomUUID();
      const publishedPlan=await developmentSlaPlan(db,sourceId);
      if(publishedPlan?.timeline_schema_version===2)await captureDevelopmentTimeline(db,actor.actorId,sourceId,1,routeId,
        ['development_materials',...developmentSlaRoute(row.document,craftPiece?'工艺布片':'整件样板',2)],row.document,row.version+1,`development-publish:${sourceId}:${key}`,time);
      const candidates = (await db.query(`SELECT DISTINCT u.id FROM app_users u JOIN user_role_assignments r ON r.user_id=u.id AND r.revoked_at IS NULL
        WHERE u.enabled AND r.role_code='development_clerk' ORDER BY u.id`)).rows;
      const eligible: string[] = [];
      for (const user of candidates) if (await new DigitalProductionAccessPolicy(db).activeRole(user.id, "development_clerk")) eligible.push(user.id);
      const { taskId } = await new DigitalProductionTaskService(this.database).createWithClient(db, actor, { resource: { kind: "source", id: sourceId }, kind: "development_materials", routeId, routeVersion: 1, occurrence: 1, assigneeId: eligible.length === 1 ? eligible[0]! : null });
      await db.query("UPDATE digital_development_documents SET status='published',published_at=$4,task_id=$2,version=version+1,updated_by=$3,updated_at=CURRENT_TIMESTAMP WHERE source_id=$1", [sourceId, taskId, actor.actorId, time.now]);
      if (await developmentSlaPlan(db,sourceId)) {
        const designer=(await db.query("SELECT created_by FROM digital_production_sources WHERE source_id=$1",[sourceId])).rows[0].created_by;
        await new DigitalProductionTaskService(this.database).createWithClient(db,actor,{resource:{kind:"source",id:sourceId},kind:"development_shipping",routeId:randomUUID(),routeVersion:1,occurrence:1,
          assigneeId:await new DigitalProductionAccessPolicy(db).activeRole(designer,"sample_designer")?designer:null});
      }
      if(patternOrder)await this.patternOrders!.inTransaction(db).createDevelopment(actor,sourceId,patternOrder.categoryId,patternOrder.priceVersion,`development-publish:${createHash("sha256").update(`${sourceId}:${key}`).digest("hex")}`,await approvedOrderTimeSource(db,actor,sourceId));
      return this.read(actor, sourceId, db);
      });
    });
  }
  async readAmendment(actor:TrustedActorContext,sourceId:string,taskId:string){return new DevelopmentAmendmentService(this.database,this.creationEnabled).read(actor,sourceId,taskId);}
  async saveAmendment(actor:TrustedActorContext,sourceId:string,input:SaveDevelopmentAmendment,key:string){return new DevelopmentAmendmentService(this.database,this.creationEnabled).save(actor,sourceId,input,key);}
  async submitAmendment(actor:TrustedActorContext,sourceId:string,input:SubmitDevelopmentAmendment,key:string){return new DevelopmentAmendmentService(this.database,this.creationEnabled).submit(actor,sourceId,input,key);}
  async amendmentReceipt(actor:TrustedActorContext,sourceId:string,taskId:string,operation:"save"|"submit",key:string){return new DevelopmentAmendmentService(this.database,this.creationEnabled).receipt(actor,sourceId,taskId,operation,key);}
  async amendmentHistory(actor:TrustedActorContext,sourceId:string,roundNumber:number){return new DevelopmentAmendmentService(this.database,this.creationEnabled).history(actor,sourceId,roundNumber);}
  async materialEvent(actor: TrustedActorContext, sourceId: string, materialId: string, input: DevelopmentMaterialEvent, key: string) {
    return this.command(actor, sourceId, "material", key, { materialId, ...input }, async db => {
      const row = await developmentDocumentRow(db,sourceId) ?? digitalNotFound();
      if (row.status !== "published" || row.version !== input.expectedVersion) conflict("请在当前已发布开发单上确认物料");
      const rounds=await developmentRoundsAvailable(db);
      const revision=Number((await db.query(`SELECT count(*) AS revision FROM digital_development_material_events WHERE source_id=$1 AND material_id=$2 ${rounds?"AND route_version=$3":""}`,[sourceId,materialId,...(rounds?[row.round_number??1]:[])])).rows[0].revision);
      if(revision!==input.expectedMaterialRevision)conflict("物料记录已更新，请刷新后重新确认");
      const material = (await effectiveVerificationDocument(db,sourceId,row.round_number??1,row.document as DevelopmentDocument)).materials.find(item => item.materialId === materialId);
      if (!material || !material.requiredThisRound) conflict("该物料不属于本轮所需");
      if (input.action === "确认代用" && material!.category !== "辅料") conflict("设计师代用确认仅适用于辅料；问题面料须供应链总监决定");
      const eventId = randomUUID();
      await db.query(`INSERT INTO digital_development_material_events(event_id,source_id,material_id,action,expected_date,note,actor_id${rounds?',route_version':''}) VALUES($1,$2,$3,$4,$5,$6,$7${rounds?',$8':''})`, [eventId, sourceId, materialId, input.action, input.expectedDate, input.note, actor.actorId,...(rounds?[row.round_number]:[])]);
      if(input.action!=='修改预计日期'){
        const occurrence=developmentOccurrence(input.actualTime,businessNow());
        await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
          VALUES($1,'source',$2,'development_material_recorded',$3,$4,$5,$6)`,[eventId,sourceId,actor.actorId,occurrence.actualCompletedAt,occurrence.timeQuality,JSON.stringify({...occurrence,materialEventId:eventId,materialId,roundNumber:row.round_number??1,action:input.action})]);
      }
      await new DevelopmentRouteService(this.database).releaseSewing(db,actor,sourceId);
      return this.read(actor, sourceId, db);
    });
  }
}
