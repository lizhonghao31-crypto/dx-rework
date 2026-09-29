import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { DigitalCustomer, DigitalOrder, DigitalOrderInput, DigitalSource, DigitalSourceInput, DigitalNumberCorrection } from "@dx-rework/contracts/digital-production";
import { isRootActor } from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { ProductionOrderRootRepository } from "./order-root-repository.js";

const fail = (message: string, status = 409): never => { throw new ApplicationError(status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "DIGITAL_PRODUCTION_CONFLICT", message, status); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const dateText = (value: Date | string | null) => value instanceof Date ? value.toISOString().slice(0, 10) : value;
export function assertIdentityActor(actor: TrustedActorContext): void {
  if (!isRootActor(actor) && (!actor.actorRoles.includes("sample_designer")
    || !(actor.authorizationCapabilities ?? []).includes("pattern_room:orders:create"))) fail("当前账号不能办理数字生产订单", 403);
}
export class DigitalProductionIdentityService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean) {}
  private async visibleOrder(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string, lock = false) {
    const result = await client.query(`SELECT o.* FROM digital_production_orders o
      WHERE production_order_id=$1 AND ($2::boolean OR created_by=$3) ${lock ? "FOR UPDATE" : ""}`, [id, isRootActor(actor), actor.actorId]);
    return result.rows[0] ?? fail("订单不存在或无权访问", 404);
  }
  private async visibleSource(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string, lock = false) {
    const result = await client.query(`SELECT * FROM digital_production_sources
      WHERE source_id=$1 AND ($2::boolean OR created_by=$3) ${lock ? "FOR UPDATE" : ""}`, [id, isRootActor(actor), actor.actorId]);
    return result.rows[0] ?? fail("开发来源不存在或无权访问", 404);
  }
  private async command<T>(actor: TrustedActorContext, command: string, key: string, payload: unknown, execute: (client: PoolClient) => Promise<T>): Promise<T> {
    assertIdentityActor(actor);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识", 400);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([actor.actorId, command, key])]);
      const hash = digest(payload);
      const prior = await client.query("SELECT payload_hash,response FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3", [actor.actorId, command, key]);
      if (prior.rows[0]) {
        if (prior.rows[0].payload_hash !== hash) fail("同一操作标识不能用于不同内容");
        const saved = prior.rows[0].response as { productionOrderId?: string; sourceId?: string };
        if (saved.productionOrderId) await this.visibleOrder(client, actor, saved.productionOrderId);
        else if (saved.sourceId) await this.visibleSource(client, actor, saved.sourceId);
        await client.query("COMMIT");
        return prior.rows[0].response as T;
      }
      const response = await execute(client);
      await client.query("INSERT INTO digital_production_commands(actor_id,command,key,payload_hash,response) VALUES($1,$2,$3,$4,$5)", [actor.actorId, command, key, hash, JSON.stringify(response)]);
      await client.query("COMMIT");
      return response;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private assertCreation() { if (!this.creationEnabled) fail("新建数字生产订单尚未开放", 403); }
  private async audit(client: PoolClient, actor: TrustedActorContext, action: string, id: string, before: unknown, after: unknown) {
    await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
      VALUES($1,$2,$3,$4,'digital_production',$5,$6,$7)`, [randomUUID(), actor.requestId, actor.actorId, action, id, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
  }
  async customers(actor: TrustedActorContext): Promise<DigitalCustomer[]> {
    assertIdentityActor(actor);
    const result = await this.database.query('SELECT code,name,product_groups AS "productGroups" FROM digital_production_customers WHERE enabled ORDER BY code');
    return result.rows;
  }
  async sources(actor: TrustedActorContext, page: number, search: string): Promise<{ items: DigitalSource[]; page: number }> {
    assertIdentityActor(actor);
    const result = await this.database.query(`SELECT s.source_id AS "sourceId",s.development_type AS "developmentType",s.design_style_no AS "designStyleNo",
      s.temporary_style_no AS "temporaryStyleNo",s.customer_code AS "customerCode",s.created_by AS "createdBy",s.created_at AS "createdAt",o.production_order_id AS "productionOrderId"
      FROM digital_production_sources s LEFT JOIN digital_production_orders o ON o.source_id=s.source_id
      WHERE ($1::boolean OR s.created_by=$2) AND ($3='' OR strpos(lower(s.design_style_no),lower($3))>0)
      ORDER BY s.created_at DESC,s.source_id DESC LIMIT 20 OFFSET $4`, [isRootActor(actor), actor.actorId, search, (page - 1) * 20]);
    return { items: result.rows, page };
  }
  async createSource(actor: TrustedActorContext, input: DigitalSourceInput, key: string): Promise<{ sourceId: string }> {
    this.assertCreation();
    return this.command(actor, "create-source", key, input, async client => {
      if (input.customerCode) await this.customer(client, input.customerCode);
      const id = randomUUID();
      await client.query(`INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,temporary_style_no,customer_code)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, actor.actorId, input.developmentType, input.designStyleNo, input.temporaryStyleNo, input.customerCode]);
      await this.audit(client, actor, "digital_source_created", id, null, input);
      return { sourceId: id };
    });
  }
  private async customer(client: PoolClient, code: string, group?: string) {
    const result = await client.query("SELECT * FROM digital_production_customers WHERE code=$1 AND enabled AND ($2::text IS NULL OR $2=ANY(product_groups))", [code, group ?? null]);
    if (!result.rows[0]) fail("客户或产品分组不可用", 400);
  }
  async createOrder(actor: TrustedActorContext, input: DigitalOrderInput, key: string, sourceId: string | null = null): Promise<DigitalOrder> {
    this.assertCreation();
    if (new Set(input.lines.map(line => line.color.trim().toLowerCase())).size !== input.lines.length) fail("同一母单颜色不能重复", 400);
    return this.command(actor, sourceId ? `confirm-source:${sourceId}` : "direct-order", key, input, async client => {
      await this.customer(client, input.customerCode, input.productGroup);
      let createdBy = actor.actorId;
      if (sourceId) {
        const source = await this.visibleSource(client, actor, sourceId, true);
        createdBy = source.created_by;
        if (source.design_style_no !== input.designStyleNo || (source.temporary_style_no ?? "") !== (input.temporaryStyleNo ?? "") || (source.customer_code && source.customer_code !== input.customerCode)) fail("下单资料与开发来源不一致");
        const existing = await client.query("SELECT production_order_id,creation_hash FROM digital_production_orders WHERE source_id=$1", [sourceId]);
        if (existing.rows[0]) {
          if (existing.rows[0].creation_hash !== digest(input)) fail("该开发来源已确认下单，不能重复建立不同订单");
          return this.readWith(client, actor, existing.rows[0].production_order_id);
        }
      }
      const root = await new ProductionOrderRootRepository(client).create(createdBy);
      await client.query(`INSERT INTO digital_production_orders(production_order_id,source_id,customer_code,product_group,design_style_no,temporary_style_no,order_date,contract_delivery_date,created_by,creation_hash)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [root.productionOrderId, sourceId, input.customerCode, input.productGroup, input.designStyleNo, input.temporaryStyleNo, input.orderDate, input.contractDeliveryDate, createdBy, digest(input)]);
      for (const [position, line] of input.lines.entries()) {
        const lineId = randomUUID();
        await client.query(`INSERT INTO digital_production_po_lines(line_id,production_order_id,position,po_number,formal_style_no,temporary_style_no,color,color_foreign,delivery_date)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [lineId, root.productionOrderId, position + 1, line.poNumber, line.formalStyleNo, line.temporaryStyleNo, line.color, line.colorForeign, line.deliveryDate]);
        for (const size of line.sizes) await client.query("INSERT INTO digital_production_po_sizes(line_id,size,quantity) VALUES($1,$2,$3)", [lineId, size.size, size.quantity]);
      }
      await this.audit(client, actor, "digital_order_created", root.productionOrderId, null, input);
      return this.readWith(client, actor, root.productionOrderId);
    });
  }
  async attachSource(actor: TrustedActorContext, id: string, sourceId: string, key: string): Promise<DigitalOrder> {
    return this.command(actor, `attach-source:${id}`, key, { sourceId }, async client => {
      const source = await this.visibleSource(client, actor, sourceId, true);
      const order = await this.visibleOrder(client, actor, id, true);
      if (order.source_id === sourceId) return this.readWith(client, actor, id);
      if (order.source_id || order.design_style_no !== source.design_style_no || (order.temporary_style_no ?? "") !== (source.temporary_style_no ?? "") || (source.customer_code && source.customer_code !== order.customer_code)) fail("开发来源与订单不匹配或已有关联");
      const used = await client.query("SELECT 1 FROM digital_production_orders WHERE source_id=$1", [sourceId]);
      if (used.rowCount) fail("该开发来源已有履约母单");
      await client.query("UPDATE digital_production_orders SET source_id=$2,version=version+1 WHERE production_order_id=$1", [id, sourceId]);
      await this.audit(client, actor, "digital_source_attached", id, { sourceId: null }, { sourceId });
      return this.readWith(client, actor, id);
    });
  }
  async read(actor: TrustedActorContext, id: string): Promise<DigitalOrder> { assertIdentityActor(actor); return this.readWith(this.database, actor, id); }
  private async readWith(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string): Promise<DigitalOrder> {
    const row = await this.visibleOrder(client, actor, id);
    const lines = await client.query(`SELECT l.line_id AS "lineId",l.po_number AS "poNumber",l.formal_style_no AS "formalStyleNo",l.temporary_style_no AS "temporaryStyleNo",
      l.color,l.color_foreign AS "colorForeign",l.delivery_date::text AS "deliveryDate",
      (SELECT jsonb_agg(jsonb_build_object('size',s.size,'quantity',s.quantity) ORDER BY s.size) FROM digital_production_po_sizes s WHERE s.line_id=l.line_id) AS sizes
      FROM digital_production_po_lines l WHERE production_order_id=$1 ORDER BY position`, [id]);
    return { productionOrderId: id, sourceId: row.source_id, customerCode: row.customer_code, productGroup: row.product_group,
      designStyleNo: row.design_style_no, temporaryStyleNo: row.temporary_style_no, orderDate: dateText(row.order_date)!, contractDeliveryDate: dateText(row.contract_delivery_date),
      createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString(), status: row.source_id ? "development_linked" : "waiting_development",
      version: row.version, workflowGeneration: "digital_production_v1", notificationPolicy: "IN_APP_ONLY", lines: lines.rows };
  }
  async orders(actor: TrustedActorContext, page: number, search: string): Promise<{ items: DigitalOrder[]; page: number }> {
    assertIdentityActor(actor);
    const rows = await this.database.query(`SELECT production_order_id FROM digital_production_orders o
      WHERE ($1::boolean OR created_by=$2) AND ($3='' OR strpos(lower(design_style_no),lower($3))>0 OR strpos(lower(coalesce(temporary_style_no,'')),lower($3))>0
        OR EXISTS(SELECT 1 FROM digital_production_po_lines l WHERE l.production_order_id=o.production_order_id AND
          (strpos(lower(coalesce(l.formal_style_no,'')),lower($3))>0 OR strpos(lower(coalesce(l.po_number,'')),lower($3))>0)))
      ORDER BY created_at DESC,production_order_id DESC LIMIT 20 OFFSET $4`, [isRootActor(actor), actor.actorId, search, (page - 1) * 20]);
    return { items: await Promise.all(rows.rows.map(row => this.readWith(this.database, actor, row.production_order_id))), page };
  }
  async correctNumbers(actor: TrustedActorContext, id: string, lineId: string, input: DigitalNumberCorrection, key: string): Promise<DigitalOrder> {
    return this.command(actor, `numbers:${id}:${lineId}`, key, input, async client => {
      const order = await this.visibleOrder(client, actor, id, true);
      if (order.version !== input.expectedVersion) fail("订单已更新，请刷新后重试");
      const line = await client.query("SELECT po_number,formal_style_no FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2", [id, lineId]);
      if (!line.rows[0]) fail("款色明细不存在", 404);
      // Downstream documents are introduced in P09 onward. Never silently leave an already linked document stale.
      const links = await client.query("SELECT 1 FROM digital_production_child_links WHERE production_order_id=$1 LIMIT 1", [id]);
      if (links.rowCount) fail("关联单据的编号同步尚未接入，不能仅修改母单号码");
      await client.query("UPDATE digital_production_po_lines SET po_number=$3,formal_style_no=$4 WHERE production_order_id=$1 AND line_id=$2", [id, lineId, input.poNumber, input.formalStyleNo]);
      await client.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1", [id]);
      await this.audit(client, actor, "digital_numbers_corrected", id, line.rows[0], { lineId, ...input });
      return this.readWith(client, actor, id);
    });
  }
}
