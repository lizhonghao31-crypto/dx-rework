import { BulkPreparationService } from "./bulk-preparation-service.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { initialInstruction, instructionErrors, type InstructionDocument, type InstructionSheet } from "@dx-rework/contracts/production-instruction";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound } from "./access-policy.js";
import { DigitalProductionIdentityService } from "./identity-service.js";
import { developmentDocumentRow } from "./development-round-repository.js";

type Database = Pick<Pool | PoolClient, "query">;
const fail = (message: string): never => { throw new ApplicationError("INSTRUCTION_CONFLICT", message, 409); };
export class ProductionInstructionService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean) {}
  private identity = () => new DigitalProductionIdentityService(this.database, this.creationEnabled);
  private async order(db: Database, actor: TrustedActorContext, id: string, write = false) {
    const order = await this.identity().readWithClient(actor, id, db);
    const editable = isRootActor(actor) || actor.actorRoles.includes("order_merchandiser") && order.primaryMerchandiserId === actor.actorId && await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId, "order_merchandiser");
    if (write && !editable) digitalForbidden();
    return { order, editable };
  }
  async cutStarted(db: Database, id: string): Promise<boolean> {
    return Boolean((await db.query(`SELECT 1 FROM digital_production_child_links l JOIN cutting_orders c ON c.sourcing_case_id=l.child_id
      JOIN cutting_records r ON r.cutting_order_id=c.cutting_order_id WHERE l.module='sourcing' AND l.production_order_id=$1 LIMIT 1`, [id])).rowCount);
  }
  private async seed(db: Database, order: DigitalOrder) {
    const document = initialInstruction(); document.sizes = [...new Set(order.lines.flatMap(line => line.sizes.map(size => size.size)))];
    const row = order.sourceId ? await developmentDocumentRow(db, order.sourceId) : null;
    if (!row || row.status !== "published") return { document, sourceRound: null };
    const source = row.document as DevelopmentDocument;
    document.secondaryCraft=source.craft; document.unit = source.unit; document.process = [source.craft === "无" ? "" : source.craft, source.washing === "免洗" ? "" : source.washing].filter(Boolean).join("／");
    document.comments = source.instructions;
    document.measurements = source.measurements.map(item => ({ id: randomUUID(), name: item.name, tolerance: "", method: "", values: document.sizes.map(size => item.values[source.sizes.indexOf(size)] ?? "") }));
    document.images = source.files.filter(file => file.kind === "款图" || file.kind === "局部图").map(file => ({ attachmentId: file.attachmentId, kind: file.kind === "款图" ? "款图" : "其它工艺", description: "" }));
    document.fabrics = source.materials.filter(item => item.category !== "辅料").map(item => ({ id: randomUUID(), name: item.name, part: item.label, colors: Object.fromEntries(order.lines.map(line => [line.lineId, item.color])), remarks: [item.width, item.weight, item.composition].filter(Boolean).join("／") }));
    document.accessories = source.materials.filter(item => item.category === "辅料").map(item => ({ id: randomUUID(), group: "车缝", garmentColors: order.lines.map(line => line.color).join("、"), materialColor: item.color, name: item.name, category: "", part: item.label, specification: item.specification, consumption: item.consumption, remarks: "" }));
    document.composition = source.materials.filter(item => item.category === "主布").map(item => item.composition).filter(Boolean).join("／");
    return { document, sourceRound: row.round_number ?? 1 };
  }
  async read(actor: TrustedActorContext, id: string, db: Database = this.database, version?: number): Promise<InstructionSheet> {
    const { order, editable } = await this.order(db, actor, id);
    const cutStarted = await this.cutStarted(db, id);
    const draftAccess=editable&&!cutStarted;
    const published=(await db.query("SELECT published_version FROM digital_instruction_documents WHERE production_order_id=$1",[id])).rows[0]?.published_version??null;
    const selectedVersion=version??(!draftAccess?published:null);
    const row = !draftAccess&&!selectedVersion?undefined:(await db.query(selectedVersion ? "SELECT * FROM digital_instruction_versions WHERE production_order_id=$1 AND version=$2" : "SELECT * FROM digital_instruction_documents WHERE production_order_id=$1", selectedVersion ? [id, selectedVersion] : [id])).rows[0];
    if (version && !row) digitalNotFound();
    const seeded = row ? { document: row.document, sourceRound: row.source_round } : draftAccess?await this.seed(db, order):{document:initialInstruction(),sourceRound:null};
    const name = order.primaryMerchandiserId ? (await db.query("SELECT display_name FROM app_users WHERE id=$1", [order.primaryMerchandiserId])).rows[0]?.display_name ?? null : null;
    const dateRequests = (await db.query(`SELECT r.request_id AS "requestId",r.old_date::text AS "oldDate",r.new_date::text AS date,r.reason,
      CASE WHEN d.request_id IS NULL THEN '待批准' WHEN d.approved THEN '已批准' ELSE '已驳回' END AS status
      FROM digital_instruction_date_requests r LEFT JOIN digital_instruction_date_decisions d USING(request_id) WHERE r.production_order_id=$1 ORDER BY r.requested_at DESC`, [id])).rows;
    dateRequests.push(...(await db.query(`SELECT r.request_id AS "requestId",true AS legacy,r.previous_date::text AS "oldDate",r.requested_date::text AS date,r.reason,
      CASE WHEN d.request_id IS NULL THEN '待批准' WHEN d.decision='approved' THEN '已批准' ELSE '已驳回' END AS status
      FROM digital_production_delivery_requests r LEFT JOIN digital_production_delivery_decisions d USING(request_id) WHERE r.production_order_id=$1 ORDER BY r.created_at DESC`,[id])).rows);
    return { order: selectedVersion ? {...row.order_snapshot,lines:(row.order_snapshot as DigitalOrder).lines.map(line=>{const current=order.lines.find(l=>l.lineId===line.lineId);return current?{...line,poNumber:current.poNumber,formalStyleNo:current.formalStyleNo,temporaryStyleNo:current.temporaryStyleNo}:line;})} : order, currentOrderVersion:order.version,currentDeliveryDate:order.contractDeliveryDate, document: seeded.document, version: row?.version ?? 0,
      publishedVersion: selectedVersion ?? published, isPublishedSnapshot:Boolean(selectedVersion), sourceRound: seeded.sourceRound, latestSourceRound: order.sourceId?(await developmentDocumentRow(db,order.sourceId))?.round_number??null:null,
      versions: (await db.query("SELECT version FROM digital_instruction_versions WHERE production_order_id=$1 ORDER BY version DESC", [id])).rows.map(r => r.version),
      canEdit: draftAccess && !version && (Boolean(row) || this.creationEnabled), cutStarted, merchandiserName: name,
      canApproveDate: isRootActor(actor) || actor.actorRoles.includes("production_management"), printedBy: (await db.query("SELECT display_name FROM app_users WHERE id=$1",[actor.actorId])).rows[0]?.display_name ?? "", dateRequests };
  }
  private async command<T>(actor: TrustedActorContext, id: string, action: string, key: string, input: unknown, work: (db: PoolClient, order: DigitalOrder) => Promise<T>, leader = false, rejectingDate = false): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识");
    const db = await this.database.connect();
    try {
      await db.query("BEGIN"); await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [id]);
      const { order } = await this.order(db, actor, id, !leader);
      if (leader && !isRootActor(actor) && !actor.actorRoles.includes("production_management")) digitalForbidden();
      const command = `instruction:${id}:${action}`, hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = (await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key])).rows[0];
      if (prior && prior.payload_hash !== hash) fail("操作标识已用于不同内容");
      if (prior) { await db.query("COMMIT"); return prior.response; }
      const state = (await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1", [id])).rows[0]?.state;
      if (!rejectingDate && state && state !== "active") fail("母单已暂停或取消");
      if (!rejectingDate && await this.cutStarted(db, id)) fail("已经开裁，不能实质修改制单；编号请从母单补齐");
      const result = await work(db, order);
      await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(result)]);
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_instruction',$5,$6)", [randomUUID(), actor.requestId, actor.actorId, action, id, JSON.stringify({ action, version: (result as InstructionSheet).version })]);
      await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  private async bindImages(db: PoolClient, actor: TrustedActorContext, order: DigitalOrder, document: InstructionDocument) {
    const source = order.sourceId ? await developmentDocumentRow(db, order.sourceId) : null;
    const permitted = source?.status === "published" ? (source.document as DevelopmentDocument).files.filter(file => ["款图", "局部图", "工艺开发板"].includes(file.kind)).map(file => file.attachmentId) : [];
    for (const image of [...document.images].sort((a,b) => a.attachmentId.localeCompare(b.attachmentId))) {
      const row = (await db.query("SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE", [image.attachmentId])).rows[0];
      if (!row || row.status !== "ready" || !["image/jpeg", "image/png", "image/webp"].includes(row.mime_type)) fail("制单图片须为已上传完成的 JPG、PNG 或 WebP");
      const bound = (await db.query("SELECT 1 FROM digital_instruction_attachment_bindings WHERE production_order_id=$1 AND attachment_id=$2", [order.productionOrderId, image.attachmentId])).rowCount;
      if (!bound && !(row.entity_type === "digital_development" && row.entity_id === order.sourceId && permitted.includes(image.attachmentId))) {
        if (row.entity_type || row.uploaded_by !== actor.actorId) digitalForbidden();
        await db.query("UPDATE attachments SET entity_type='digital_instruction',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [image.attachmentId, order.productionOrderId]);
      }
      await db.query("INSERT INTO digital_instruction_attachment_bindings(production_order_id,attachment_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [order.productionOrderId, image.attachmentId]);
    }
  }
  async save(actor: TrustedActorContext, id: string, input: { expectedVersion: number; orderVersion: number; document: InstructionDocument }, key: string) {
    return this.command(actor,id,"save",key,input,async(db,order) => {
      const current = await this.read(actor,id,db);
      if (!current.canEdit || current.version !== input.expectedVersion || order.version !== input.orderVersion) fail("母单或制单已更新，请重新打开");
      await this.bindImages(db,actor,order,input.document);
      await db.query(`INSERT INTO digital_instruction_documents(production_order_id,version,order_version,document,source_round,updated_by) VALUES($1,1,$2,$3,$4,$5)
        ON CONFLICT(production_order_id) DO UPDATE SET version=digital_instruction_documents.version+1,order_version=EXCLUDED.order_version,document=EXCLUDED.document,source_round=EXCLUDED.source_round,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`, [id,order.version,JSON.stringify(input.document),current.latestSourceRound,actor.actorId]);
      return this.read(actor,id,db);
    });
  }
  private async notice(db: PoolClient, order: DigitalOrder, version: number | null, title: string, key: string, directorsOnly = false) {
    const eventId = randomUUID();
    await db.query("INSERT INTO digital_production_notification_events(event_id,source_key,instruction_order_id,event_kind) VALUES($1,$2,$3,'instruction_information')", [eventId,key,order.productionOrderId]);
    await db.query("INSERT INTO digital_instruction_notices(event_id,version,title) VALUES($1,$2,$3)",[eventId,version,`${order.designStyleNo} · ${title}`]);
    const people = (await db.query(`SELECT DISTINCT u.id FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
      AND (a.role_code='production_management' OR ($2::boolean=false AND (a.role_code='owner_group' OR (a.role_code='sample_designer' AND u.id=$1))))`,[order.createdBy,directorsOnly])).rows;
    for (const p of people) await db.query("INSERT INTO digital_production_notification_receipts(event_id,source_event_id,recipient_id) VALUES($1,$1,$2)",[eventId,p.id]);
  }
  async publish(actor: TrustedActorContext,id:string,input:{expectedVersion:number;orderVersion:number},key:string) {
    return this.command(actor,id,"publish",key,input,async(db,order) => {
      const current=await this.read(actor,id,db);
      if (!current.canEdit || !current.version || current.version!==input.expectedVersion || order.version!==input.orderVersion) fail("母单或制单已更新，请重新打开");
      if(current.publishedVersion===current.version)return current;
      if(current.sourceRound!==current.latestSourceRound)fail("开发资料已更新，请核对制单并保存新版本后发布");
      const issues=instructionErrors(current.document,order);if(issues.length)fail(issues.join("；"));
      await this.bindImages(db,actor,order,current.document);
      await db.query("INSERT INTO digital_instruction_versions(production_order_id,version,order_version,document,order_snapshot,source_round,published_by) VALUES($1,$2,$3,$4,$5,$6,$7)",[id,current.version,order.version,JSON.stringify(current.document),JSON.stringify(order),current.sourceRound,actor.actorId]);
      await db.query("UPDATE digital_instruction_documents SET published_version=version WHERE production_order_id=$1",[id]);
      await this.notice(db,order,current.version,"大货制单已发布",`instruction:${id}:${current.version}`);
      await new BulkPreparationService(this.database).sync(db,actor,id);
      return this.read(actor,id,db);
    });
  }
  async requestDate(actor:TrustedActorContext,id:string,input:{orderVersion:number;date:string;reason:string},key:string){
    return this.command(actor,id,"date-request",key,input,async(db,order)=>{
      if(order.version!==input.orderVersion)fail("母单已更新，请重新打开");
      if(input.date<order.orderDate || input.date===order.contractDeliveryDate)fail("请填写晚于下单日期且不同于当前值的新客户交付期");
      const requestId=randomUUID();await db.query("INSERT INTO digital_instruction_date_requests(request_id,production_order_id,order_version,old_date,new_date,reason,requested_by) VALUES($1,$2,$3,$4,$5,$6,$7)",[requestId,id,order.version,order.contractDeliveryDate,input.date,input.reason,actor.actorId]);
      await this.notice(db,order,null,"客户交付期变更待批准",`instruction-date:${requestId}`,true);return this.read(actor,id,db);
    });
  }
  async decideDate(actor:TrustedActorContext,id:string,requestId:string,approved:boolean,key:string){
    return this.command(actor,id,"date-decision",key,{requestId,approved},async(db,order)=>{
      const row=(await db.query("SELECT *,new_date::text AS date FROM digital_instruction_date_requests WHERE request_id=$1 AND production_order_id=$2",[requestId,id])).rows[0]??digitalNotFound();
      if(!isRootActor(actor) && row.requested_by===actor.actorId)digitalForbidden();
      if((await db.query("SELECT 1 FROM digital_instruction_date_decisions WHERE request_id=$1",[requestId])).rowCount)fail("申请已处理");
      if(approved && order.version!==row.order_version)fail("母单已更新，请重新申请");
      await db.query("INSERT INTO digital_instruction_date_decisions(request_id,approved,decided_by) VALUES($1,$2,$3)",[requestId,approved,actor.actorId]);
      if(approved)await db.query("UPDATE digital_production_orders SET contract_delivery_date=$2,version=version+1 WHERE production_order_id=$1",[id,row.date]);
      await this.notice(db,order,null,approved?"客户交付期变更已批准":"客户交付期变更已驳回",`instruction-date-decision:${requestId}`);return this.read(actor,id,db);
    },true,!approved);
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
    await this.notice(db,await this.identity().readWithClient(actor,id,db),null,title,key,directorsOnly);
  }
  async authorizeUpload(actor:TrustedActorContext,id:string){const current=await this.read(actor,id);if(!current.canEdit)digitalForbidden();}
  async canDownload(actor:TrustedActorContext,id:string,attachmentId:string){
    const current=await this.read(actor,id);
    if(current.canEdit){
      if((await this.database.query("SELECT 1 FROM digital_instruction_attachment_bindings WHERE production_order_id=$1 AND attachment_id=$2",[id,attachmentId])).rowCount)return true;
      return current.document.images.some(image=>image.attachmentId===attachmentId);
    }
    return Boolean((await this.database.query("SELECT 1 FROM digital_instruction_versions v CROSS JOIN LATERAL jsonb_array_elements(v.document->'images') image WHERE v.production_order_id=$1 AND image->>'attachmentId'=$2 LIMIT 1",[id,attachmentId])).rowCount);
  }
}
