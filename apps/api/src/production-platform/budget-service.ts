import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { budgetPublishErrors, calculateBudget, type BudgetDocument, type BudgetSheet, type BudgetSourcingPreparation } from "@dx-rework/contracts/digital-budget";
import type { AttachmentService } from "../tools/attachments.js";
import { readBudgetSourcing } from "./budget-sourcing-adapter.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound } from "./access-policy.js";

type Database = Pick<Pool | PoolClient, "query">;
const conflict = (message: string): never => { throw new ApplicationError("BUDGET_CONFLICT", message, 409); };
export class DigitalBudgetService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean) {}
  async prepareSourcing(actor: TrustedActorContext, orderId: string, expectedVersion: number, attachments: AttachmentService): Promise<BudgetSourcingPreparation> {
    const source = await readBudgetSourcing(this.database, actor, orderId);
    if (source.budgetVersion !== expectedVersion) conflict("预算已更新，请重新打开后发起");
    const images: BudgetSourcingPreparation["images"] = [];
    for (const id of source.document.imageAttachmentIds) {
      const copy = await attachments.copyDigitalBudgetImage(actor, orderId, expectedVersion, id);
      images.push({ attachmentId: copy.attachmentId, filename: copy.filename, mimeType: copy.mimeType });
    }
    return { productionOrderId: orderId, budgetVersion: source.budgetVersion, orderVersion: source.order.version,
      gender: ["男装", "男童"].includes(source.order.product_group) ? "男装" : "女装", styleName: source.document.productCategory,
      contractDeliveryDate: source.order.delivery, daxingUnitPrice: source.document.outsourcingUnitPrice,customerCode:source.order.customer_code,budgetRows:source.document.rows,
      lineItems: source.lines.map(line => ({ lineId: line.line_id, styleNo: line.formal_style_no ?? "", alternateStyleNo: line.temporary_style_no || source.order.temporary_style_no || source.order.design_style_no, color: line.color, quantity: line.quantity, customerWarehouseArrivalDate: line.customer })), images };
  }
  private async order(db: Database, actor: TrustedActorContext, orderId: string, write = false) {
    await new DigitalProductionAccessPolicy(db).assert(actor, "order", orderId, "budget");
    const order = (await db.query(`SELECT o.*,u.display_name AS designer_name,m.display_name AS merchandiser_name
      FROM digital_production_orders o JOIN app_users u ON u.id=o.created_by
      LEFT JOIN app_users m ON m.id=o.primary_merchandiser_id WHERE o.production_order_id=$1`, [orderId])).rows[0] ?? digitalNotFound();
    const canEdit = isRootActor(actor) || actor.actorRoles.includes("sample_designer") && order.created_by === actor.actorId;
    if (write && !canEdit) digitalForbidden();
    return { ...order, canEdit };
  }
  async read(actor: TrustedActorContext, orderId: string, db: Database = this.database, version?: number): Promise<BudgetSheet> {
    const order = await this.order(db, actor, orderId);
    const linked = (await db.query("SELECT child_id FROM digital_production_child_links WHERE module='sourcing' AND production_order_id=$1", [orderId])).rows[0];
    const row = (await db.query(version === undefined ? "SELECT * FROM digital_budget_documents WHERE production_order_id=$1" : "SELECT *, 'published' AS status FROM digital_budget_versions WHERE production_order_id=$1 AND version=$2", version === undefined ? [orderId] : [orderId, version])).rows[0];
    if (version !== undefined && !row) digitalNotFound();
    return { versions:(await db.query("SELECT version FROM digital_budget_versions WHERE production_order_id=$1 ORDER BY version DESC",[orderId])).rows.map(item=>item.version), productionOrderId: orderId, version: row?.version ?? 0, status: row?.status ?? "draft", document: row?.document ?? null,
      totals: row ? calculateBudget(row.document) : null, canEdit: order.canEdit && !linked && version === undefined && (Boolean(row) || this.creationEnabled),
      canSubmitSourcing: !linked && row?.status === "published" && (isRootActor(actor) || actor.actorRoles.includes("order_merchandiser") && order.primary_merchandiser_id === actor.actorId),
      sourcingCaseId: linked?.child_id ?? null, publishedAt: row?.published_at ? new Date(row.published_at).toISOString() : null,
      designerName: order.designer_name, merchandiserName: order.merchandiser_name ?? null };
  }
  private async command<T>(actor: TrustedActorContext, orderId: string, action: string, key: string, payload: unknown, work: (db: PoolClient) => Promise<T>): Promise<T> {
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) conflict("缺少有效操作标识");
    const db = await this.database.connect();
    try {
      await db.query("BEGIN");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await db.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [orderId]);
      await this.order(db, actor, orderId, true);
      const command = `budget:${orderId}:${action}`;
      const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
      const prior = (await db.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key])).rows[0];
      if (prior && prior.payload_hash !== hash) conflict("同一操作标识不能用于不同内容");
      if (prior) { await db.query("COMMIT"); return prior.response as T; }
      const sheet = await this.read(actor, orderId, db);
      if (!sheet.canEdit) conflict(sheet.sourcingCaseId ? "已进入外发审批，请通过原外发预算更正入口处理" : "当前不能新建预算");
      const lifecycle = (await db.query("SELECT state FROM digital_production_resource_lifecycle WHERE resource_kind='order' AND resource_id=$1", [orderId])).rows[0];
      if (lifecycle && lifecycle.state !== "active") conflict("当前母单已暂停或取消");
      const result = await work(db);
      await db.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(result)]);
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state) VALUES($1,$2,$3,$4,'digital_budget',$5,$6)", [randomUUID(), actor.requestId, actor.actorId, `budget_${action}`, orderId, JSON.stringify({ version: (result as BudgetSheet).version })]);
      await db.query("COMMIT"); return result;
    } catch (error) { await db.query("ROLLBACK"); throw error; } finally { db.release(); }
  }
  async authorizeUpload(actor: TrustedActorContext, orderId: string) {
    const sheet = await this.read(actor, orderId);
    if (!sheet.canEdit) digitalForbidden();
  }
  async canDownload(actor: TrustedActorContext, orderId: string, attachmentId: string): Promise<boolean> {
    await this.order(this.database, actor, orderId);
    return Boolean((await this.database.query("SELECT 1 FROM digital_budget_attachment_bindings WHERE production_order_id=$1 AND attachment_id=$2", [orderId, attachmentId])).rowCount);
  }
  private async bindFiles(db: PoolClient, actor: TrustedActorContext, orderId: string, doc: BudgetDocument) {
    for (const attachmentId of [...doc.imageAttachmentIds].sort()) {
      const file = (await db.query("SELECT * FROM attachments WHERE attachment_id=$1 FOR UPDATE", [attachmentId])).rows[0];
      if (!file || file.status !== "ready" || !["image/jpeg", "image/png", "image/webp"].includes(file.mime_type)) conflict("预算图片必须上传完成且为 JPG、PNG 或 WebP");
      if (file.entity_type ? file.entity_type !== "digital_budget" || file.entity_id !== orderId : file.uploaded_by !== actor.actorId) digitalForbidden();
      await db.query("UPDATE attachments SET entity_type='digital_budget',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [attachmentId, orderId]);
      await db.query("INSERT INTO digital_budget_attachment_bindings(attachment_id,production_order_id,bound_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [attachmentId, orderId, actor.actorId]);
    }
  }
  async save(actor: TrustedActorContext, orderId: string, input: { expectedVersion: number; document: BudgetDocument }, key: string) {
    return this.command(actor, orderId, "save", key, input, async db => {
      const row = (await db.query("SELECT version FROM digital_budget_documents WHERE production_order_id=$1", [orderId])).rows[0];
      if ((row?.version ?? 0) !== input.expectedVersion) conflict("预算已更新，请重新打开后保存");
      await this.bindFiles(db, actor, orderId, input.document);
      await db.query(`INSERT INTO digital_budget_documents(production_order_id,version,status,document,updated_by) VALUES($1,1,'draft',$2,$3)
        ON CONFLICT(production_order_id) DO UPDATE SET version=digital_budget_documents.version+1,status='draft',document=EXCLUDED.document,updated_by=EXCLUDED.updated_by,updated_at=CURRENT_TIMESTAMP,published_at=NULL`, [orderId, JSON.stringify(input.document), actor.actorId]);
      return this.read(actor, orderId, db);
    });
  }
  async publish(actor: TrustedActorContext, orderId: string, expectedVersion: number, key: string) {
    return this.command(actor, orderId, "publish", key, { expectedVersion }, async db => {
      const row = (await db.query("SELECT * FROM digital_budget_documents WHERE production_order_id=$1", [orderId])).rows[0] ?? conflict("请先保存预算");
      if (row.version !== expectedVersion) conflict("预算已更新，请重新打开后发布");
      if (row.status === "published") return this.read(actor, orderId, db);
      const errors = budgetPublishErrors(row.document);
      if (errors.length) throw new ApplicationError("VALIDATION_ERROR", errors.join("；"), 400);
      await this.bindFiles(db, actor, orderId, row.document);
      await db.query("INSERT INTO digital_budget_versions(production_order_id,version,document,totals,published_by) VALUES($1,$2,$3,$4,$5)", [orderId, row.version, JSON.stringify(row.document), JSON.stringify(calculateBudget(row.document)), actor.actorId]);
      await db.query("UPDATE digital_budget_documents SET status='published',published_at=CURRENT_TIMESTAMP,updated_by=$2 WHERE production_order_id=$1", [orderId, actor.actorId]);
      await db.query("INSERT INTO digital_budget_preparations(production_order_id,budget_version) VALUES($1,$2) ON CONFLICT(production_order_id) DO UPDATE SET budget_version=EXCLUDED.budget_version", [orderId, row.version]);
      const preparation = (await db.query("SELECT task_id FROM digital_budget_preparations WHERE production_order_id=$1", [orderId])).rows[0];
      if (!preparation.task_id) {
        const order = await this.order(db, actor, orderId);
        const assigneeId = order.primary_merchandiser_id && await new DigitalProductionAccessPolicy(db).activeRole(order.primary_merchandiser_id, "order_merchandiser") ? order.primary_merchandiser_id : null;
        const { taskId } = await new DigitalProductionTaskService(this.database).createWithClient(db, actor, { resource: { kind: "order", id: orderId }, kind: "sourcing_preparation", routeId: randomUUID(), routeVersion: 1, occurrence: 1, assigneeId });
        await db.query("UPDATE digital_budget_preparations SET task_id=$2 WHERE production_order_id=$1", [orderId, taskId]);
      }
      return this.read(actor, orderId, db);
    });
  }
}
