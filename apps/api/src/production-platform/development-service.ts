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

type Database = Pick<Pool | PoolClient, "query">;
const conflict = (message: string): never => { throw new ApplicationError("DEVELOPMENT_CONFLICT", message, 409); };
export class DigitalDevelopmentService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean, private readonly patternOrders?:PatternRoomOrderService) {}
  private async source(db: Database, actor: TrustedActorContext, sourceId: string, write = false) {
    const source = (await db.query("SELECT s.*,u.display_name AS designer_name FROM digital_production_sources s JOIN app_users u ON u.id=s.created_by WHERE s.source_id=$1", [sourceId])).rows[0] ?? digitalNotFound();
    const owner = isRootActor(actor) || (actor.actorRoles.includes("sample_designer") && source.created_by === actor.actorId && (actor.authorizationCapabilities ?? []).includes("pattern_room:orders:create"));
    if (write) { if (!this.creationEnabled || !owner) digitalForbidden(); }
    else if (!await new DigitalProductionAccessPolicy(db).allowed(actor, "source", sourceId, "technical")) {
      const tasks = (await db.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1", [sourceId])).rows;
      let visible = false;
      for (const task of tasks) if (await new DigitalProductionAccessPolicy(db).allowed(actor, "task", task.task_id, "technical")) { visible = true; break; }
      if (!visible) digitalNotFound();
    }
    return { ...source, can_edit: owner && this.creationEnabled };
  }
  async authorizeUpload(actor: TrustedActorContext, sourceId: string) { await this.source(this.database, actor, sourceId, true); }
  async canDownload(actor: TrustedActorContext, sourceId: string, attachmentId: string): Promise<boolean> {
    await this.source(this.database, actor, sourceId);
    return Boolean((await this.database.query("SELECT 1 FROM digital_development_attachment_bindings WHERE source_id=$1 AND attachment_id=$2", [sourceId, attachmentId])).rowCount);
  }
  async read(actor: TrustedActorContext, sourceId: string, db: Database = this.database, roundNumber?: number): Promise<DevelopmentSheet> {
    const source = await this.source(db, actor, sourceId);
    const row = await developmentDocumentRow(db,sourceId,roundNumber);
    const rounds=await developmentRoundsAvailable(db);
    if(roundNumber&&!row)digitalNotFound();
    const materialEvents = (await db.query(`SELECT event_id AS "eventId",material_id AS "materialId",action,expected_date::text AS "expectedDate",note,created_at AS "createdAt"
      FROM digital_development_material_events WHERE source_id=$1 ${rounds?"AND route_version<=$2":""} ORDER BY sequence`, rounds?[sourceId,row?.round_number??1]:[sourceId])).rows;
    return { sourceId, designStyleNo: source.design_style_no, temporaryStyleNo: source.temporary_style_no, customerCode: source.customer_code,
      developmentType: source.development_type, designerName: source.designer_name, version: row?.version ?? 0, status: row?.status ?? "draft",
      document: row?.document ?? null, publishedAt: row?.published_at ? new Date(row.published_at).toISOString() : null, taskId: row?.task_id ?? null,
      canRevise:source.can_edit,roundNumber:row?.round_number??1,latestRoundNumber:row?.latest_round_number??1,canEdit: source.can_edit && (!row || row.round_number===row.latest_round_number), materialEvents };
  }
  private async command<T>(actor: TrustedActorContext, sourceId: string, command: string, key: string, input: unknown, action: (db: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) conflict("缺少有效操作标识");
    const db = await this.database.connect();
    try {
      await db.query("BEGIN");
      // Same ordering as task adapters: lifecycle lock before source/attachment locks.
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await this.source(db, actor, sourceId, true);
      await db.query("SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE", [sourceId]);
      const name = `development:${sourceId}:${command}`;
      const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
      const prior = (await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, name, key])).rows[0];
      if (prior && prior.payload_hash !== hash) conflict("同一操作标识不能用于不同内容");
      const result = prior ? prior.response as T : await action(db);
      if (!prior) {
        await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, name, key, hash, JSON.stringify(result)]);
        await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_development',$5,$6)", [randomUUID(), actor.requestId, actor.actorId, `development_${command}`, sourceId, JSON.stringify({ command, version: (result as { version?: number }).version })]);
      }
      await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  async bindFiles(db: PoolClient, actor: TrustedActorContext, sourceId: string, document: DevelopmentDocument) {
    for (const file of [...document.files].sort((a,b) => a.attachmentId.localeCompare(b.attachmentId))) {
      const row = (await db.query("SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE", [file.attachmentId])).rows[0];
      if (!row || row.status !== "ready" || !["image/jpeg","image/png","image/webp","application/pdf"].includes(row.mime_type)) conflict("附件必须是已上传完成的图片或 PDF");
      if (["款图","局部图"].includes(file.kind) && !row.mime_type.startsWith("image/")) conflict("款图和局部图请使用图片");
      if (row.entity_type ? row.entity_type !== "digital_development" || row.entity_id !== sourceId : row.uploaded_by !== actor.actorId) digitalForbidden();
      await db.query("UPDATE attachments SET entity_type='digital_development',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [file.attachmentId, sourceId]);
      await db.query("INSERT INTO digital_development_attachment_bindings(attachment_id,source_id,bound_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [file.attachmentId, sourceId, actor.actorId]);
    }
  }
  async save(actor: TrustedActorContext, sourceId: string, input: { expectedVersion: number; document: DevelopmentDocument }, key: string) {
    return this.command(actor, sourceId, "save", key, input, async db => {
      const row = (await db.query("SELECT version,status FROM digital_development_documents WHERE source_id=$1", [sourceId])).rows[0];
      if ((row?.version ?? 0) !== input.expectedVersion) conflict("开发单已更新，请重新打开后再保存");
      if (row?.status === "published") conflict("已发布开发单不可覆盖，请通过复版记录实际修改");
      await this.bindFiles(db, actor, sourceId, input.document);
      await db.query(`INSERT INTO digital_development_documents(source_id,version,status,document,updated_by) VALUES($1,1,'draft',$2,$3)
        ON CONFLICT(source_id) DO UPDATE SET version=digital_development_documents.version+1,document=EXCLUDED.document,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP`, [sourceId, JSON.stringify(input.document), actor.actorId]);
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
      if(this.patternOrders&&!patternOrder)conflict("请先选择有效打板品类与执行价，再正式提交开发单");
      if(patternOrder&&!this.patternOrders)conflict("打板执行衔接服务未配置");
      await this.bindFiles(db, actor, sourceId, row.document);
      const candidates = (await db.query(`SELECT DISTINCT u.id FROM app_users u JOIN user_role_assignments r ON r.user_id=u.id AND r.revoked_at IS NULL
        WHERE u.enabled AND r.role_code='development_clerk' ORDER BY u.id`)).rows;
      const eligible: string[] = [];
      for (const user of candidates) if (await new DigitalProductionAccessPolicy(db).activeRole(user.id, "development_clerk")) eligible.push(user.id);
      const { taskId } = await new DigitalProductionTaskService(this.database).createWithClient(db, actor, { resource: { kind: "source", id: sourceId }, kind: "development_materials", routeId: randomUUID(), routeVersion: 1, occurrence: 1, assigneeId: eligible.length === 1 ? eligible[0]! : null });
      await db.query("UPDATE digital_development_documents SET status='published',published_at=CURRENT_TIMESTAMP,task_id=$2,version=version+1,updated_by=$3,updated_at=CURRENT_TIMESTAMP WHERE source_id=$1", [sourceId, taskId, actor.actorId]);
      if(patternOrder)await this.patternOrders!.inTransaction(db).createDevelopment(actor,sourceId,patternOrder.categoryId,patternOrder.priceVersion,`development-publish:${createHash("sha256").update(`${sourceId}:${key}`).digest("hex")}`);
      return this.read(actor, sourceId, db);
    });
  }
  async materialEvent(actor: TrustedActorContext, sourceId: string, materialId: string, input: DevelopmentMaterialEvent, key: string) {
    return this.command(actor, sourceId, "material", key, { materialId, ...input }, async db => {
      const row = await developmentDocumentRow(db,sourceId) ?? digitalNotFound();
      if (row.status !== "published" || row.version !== input.expectedVersion) conflict("请在当前已发布开发单上确认物料");
      const revision=Number((await db.query("SELECT count(*) AS revision FROM digital_development_material_events WHERE source_id=$1 AND material_id=$2",[sourceId,materialId])).rows[0].revision);
      if(revision!==input.expectedMaterialRevision)conflict("物料记录已更新，请刷新后重新确认");
      const material = (row.document as DevelopmentDocument).materials.find(item => item.materialId === materialId);
      if (!material || !material.requiredThisRound) conflict("该物料不属于本轮所需");
      if (input.action === "确认代用" && material!.category !== "辅料") conflict("设计师代用确认仅适用于辅料；问题面料须供应链总监决定");
      const eventId = randomUUID();
      const rounds=await developmentRoundsAvailable(db);
      await db.query(`INSERT INTO digital_development_material_events(event_id,source_id,material_id,action,expected_date,note,actor_id${rounds?',route_version':''}) VALUES($1,$2,$3,$4,$5,$6,$7${rounds?',$8':''})`, [eventId, sourceId, materialId, input.action, input.expectedDate, input.note, actor.actorId,...(rounds?[row.round_number]:[])]);
      await new DevelopmentRouteService(this.database).releaseSewing(db,actor,sourceId);
      return this.read(actor, sourceId, db);
    });
  }
}
