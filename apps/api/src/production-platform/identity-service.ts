import type { SourcingService } from "../sourcing/sourcing-service.js";
import { SlaOrderService } from "./sla-order-service.js";
import { developmentRevisionSource } from "./development-revision-source.js";
import { captureDevelopmentSla } from "./development-sla-enrollment.js";
import type { BusinessClock } from "@dx-rework/domain/business-clock";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { DigitalOrderCreateSchema, beijingCalendarDate, customerOrderDateError, initialCustomerOrderInput, digitalFormalPoNo, digitalPoKey, initialCustomerDateErrors, minimumInitialCustomerDate } from "@dx-rework/contracts/digital-production";
import {developmentDocumentRow} from "./development-round-repository.js";
import { DigitalPoDateRepository } from "./po-date-repository.js";
import type { DigitalCustomer, DigitalOrder, DigitalOrderInput, DigitalSource, DigitalSourceInput, DigitalNumberCorrection } from "@dx-rework/contracts/digital-production";
import { isRootActor } from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, isDigitalLeader, isDigitalTechnicalManager, digitalForbidden } from "./access-policy.js";
import { ProductionOrderRootRepository } from "./order-root-repository.js";

const fail = (message: string, status = 409): never => { throw new ApplicationError(status === 404 ? "NOT_FOUND" : status === 403 ? "FORBIDDEN" : "DIGITAL_PRODUCTION_CONFLICT", message, status); };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const orderFactsDigest=(value:DigitalOrderInput)=>{
  const facts=DigitalOrderCreateSchema.parse(value);
  // Assignment continues through the existing active-role/default/Root policy.
  delete facts.primaryMerchandiserId;
  return digest(facts);
};
export const digitalDateText = (value: Date | string | null) => value instanceof Date
  ? new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(value)
  : value;
export function assertIdentityActor(actor: TrustedActorContext): void {
  if (!isRootActor(actor) && !actor.actorRoles.some(role => ["sample_designer", "order_merchandiser", "owner_group", "production_management", "pattern_room_supervisor", "development_clerk", "pattern_room_tail_inspector", "pattern_room_worker", "quality_control", "embroidery_washing_merchandiser", "warehouse_receiver", "warehouse_supervisor", "cutting_worker"].includes(role))) digitalForbidden();
}
const assertCreator = (actor: TrustedActorContext) => {
  if (!isRootActor(actor) && (!actor.actorRoles.includes("sample_designer") || !(actor.authorizationCapabilities ?? []).includes("pattern_room:orders:create"))) digitalForbidden();
};
const readScope = (kind: "order" | "source", alias: string) => {
  return `($1::boolean OR ($5::boolean AND ${alias}.created_by=$2) ${kind === "order" ? `OR ($6::boolean AND ${alias}.primary_merchandiser_id=$2) OR ($7::boolean AND ${alias}.source_id IS NOT NULL)` : ""}
    )`;
};
export class DigitalProductionIdentityService {
  constructor(private readonly database: Pool, private readonly creationEnabled: boolean, private readonly sourcing?:SourcingService, private readonly now:()=>Date=()=>new Date(), private readonly businessClock?: BusinessClock) {}
  private async visibleOrder(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string, lock = false) {
    await new DigitalProductionAccessPolicy(client).assert(actor, "order", id, "technical");
    const result = await client.query(`SELECT o.* FROM digital_production_orders o WHERE production_order_id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ?? fail("订单不存在或无权访问", 404);
  }
  private async visibleSource(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string, lock = false) {
    await new DigitalProductionAccessPolicy(client).assert(actor, "source", id, "technical");
    const result = await client.query(`SELECT * FROM digital_production_sources WHERE source_id=$1 ${lock ? "FOR UPDATE" : ""}`, [id]);
    return result.rows[0] ?? fail("开发来源不存在或无权访问", 404);
  }
  private async command<T>(actor: TrustedActorContext, command: string, key: string, payload: unknown, execute: (client: PoolClient) => Promise<T>): Promise<T> {
    assertIdentityActor(actor);
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) fail("缺少有效操作标识", 400);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      if(command.startsWith("numbers:")||command.startsWith("confirm-source:"))await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
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
    const eventId = randomUUID();
    await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
      VALUES($1,$2,$3,$4,'digital_production',$5,$6,$7)`, [eventId, actor.requestId, actor.actorId, action, id, before ? JSON.stringify(before) : null, JSON.stringify(after)]);
    return eventId;
  }
  async customers(actor: TrustedActorContext): Promise<DigitalCustomer[]> {
    assertIdentityActor(actor);
    const result = await this.database.query('SELECT c.code,c.name,c.product_groups AS "productGroups",c.default_merchandiser_id AS "defaultMerchandiserId",u.display_name AS "defaultMerchandiserName" FROM digital_production_customers c LEFT JOIN app_users u ON u.id=c.default_merchandiser_id WHERE c.enabled ORDER BY c.code');
    return result.rows;
  }
  async sources(actor: TrustedActorContext, page: number, search: string): Promise<{ items: DigitalSource[]; page: number }> {
    assertIdentityActor(actor);
    const result = await this.database.query(`SELECT s.source_id AS "sourceId",s.development_type AS "developmentType",s.design_style_no AS "designStyleNo",
      s.temporary_style_no AS "temporaryStyleNo",s.customer_code AS "customerCode",s.created_by AS "createdBy",s.created_at AS "createdAt",o.production_order_id AS "productionOrderId"
      FROM digital_production_sources s LEFT JOIN digital_production_orders o ON o.source_id=s.source_id
      WHERE ${readScope("source", "s")} AND ($3='' OR strpos(lower(s.design_style_no),lower($3))>0)
      AND ($6::boolean OR NOT $6::boolean) ORDER BY s.created_at DESC,s.source_id DESC LIMIT 15 OFFSET $4`, [isDigitalLeader(actor) || isDigitalTechnicalManager(actor), actor.actorId, search, (page - 1) * 15, actor.actorRoles.includes("sample_designer"), actor.actorRoles.includes("order_merchandiser")]);
    return { items: result.rows, page };
  }
  async createSource(actor: TrustedActorContext, input: DigitalSourceInput, key: string): Promise<{ sourceId: string }> {
    this.assertCreation();
    assertCreator(actor);
    return this.command(actor, "create-source", key, input, async client => {
      if (input.customerCode) await this.customer(client, input.customerCode);
      const styleKey = digitalPoKey(input.designStyleNo);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["digital-source-style",styleKey])]);
      if ((await client.query("SELECT 1 FROM digital_production_sources WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1 LIMIT 1", [styleKey])).rowCount)
        fail("该编号已有开发档案，请打开原档案继续办理");
      const id = randomUUID();
      await client.query(`INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,temporary_style_no,customer_code)
        VALUES($1,$2,$3,$4,$5,$6)`, [id, actor.actorId, input.developmentType, input.designStyleNo, input.temporaryStyleNo, input.customerCode]);
      const eventId = await this.audit(client, actor, "digital_source_created", id, null, input);
      const time = this.businessClock ? await this.businessClock.read({ kind: "source", id })
        : { now: this.now().toISOString(), scenarioId: null, revision: 0 };
      await captureDevelopmentSla(client, actor, id, null, time, eventId);
      return { sourceId: id };
    });
  }
  private async customer(client: PoolClient, code: string, group?: string) {
    const result = await client.query("SELECT * FROM digital_production_customers WHERE code=$1 AND enabled AND ($2::text IS NULL OR $2=ANY(product_groups))", [code, group ?? null]);
    if (!result.rows[0]) fail("客户或产品分组不可用", 400);
  }
  async createOrder(actor: TrustedActorContext, input: DigitalOrderInput, key: string, sourceId: string | null = null): Promise<DigitalOrder> {
    this.assertCreation();
    assertCreator(actor);
    if (new Set(input.lines.map(line => line.color.trim().toLowerCase())).size !== input.lines.length) fail("同一母单颜色不能重复", 400);
    const poKeys = input.lines.map(line => digitalPoKey(digitalFormalPoNo(line))).filter(Boolean);
    if (new Set(poKeys).size !== poKeys.length) fail("同一母单正式款号（PO）不能重复",400);
    for (const line of input.lines) if (new Set([line.formalPoNo,line.formalStyleNo,line.poNumber].map(digitalPoKey).filter(Boolean)).size > 1)
      fail("正式款号（PO）只能有一个有效值",400);
    for (const line of input.lines) if (line.customerWarehouseArrivalDate!==undefined && line.deliveryDate!==undefined && line.deliveryDate!==null
      && line.customerWarehouseArrivalDate!==line.deliveryDate) fail("出货日期不能互相矛盾",400);
    return this.command(actor, sourceId ? `confirm-source:${sourceId}` : "direct-order", key, input, async client => {
      await this.customer(client, input.customerCode, input.productGroup);
      let createdBy = actor.actorId;
      if (sourceId) {
        const source = await this.visibleSource(client, actor, sourceId, true);
        if(await developmentRevisionSource(client,sourceId))fail('复版沿原开发档案的客户订单，不重复建立大货数量');
        if (!isRootActor(actor) && source.created_by !== actor.actorId) digitalForbidden();
        createdBy = source.created_by;
        if (source.design_style_no !== input.designStyleNo || (source.temporary_style_no ?? "") !== (input.temporaryStyleNo ?? "") || (source.customer_code && source.customer_code !== input.customerCode)) fail("下单资料与开发来源不一致");
        const existing = await client.query("SELECT production_order_id,creation_hash FROM digital_production_orders WHERE source_id=$1", [sourceId]);
        if (existing.rows[0]) {
          if (existing.rows[0].creation_hash !== digest(input)) fail("该开发来源已确认下单，不能重复建立不同订单");
          return this.readWith(client, actor, existing.rows[0].production_order_id);
        }
        const published=await developmentDocumentRow(client,sourceId);
        if(published?.status!=="published")fail("请先发布开发单，再正式确认客户订单");
        if(published.document?.customerOrderDraft?.withOrder&&orderFactsDigest(input)!==orderFactsDigest(initialCustomerOrderInput(published.document.customerOrderDraft.order)))
          fail("确认信息须与当前已发布的订购草稿一致，请重新打开原档案恢复资料");
      }
      const styleKey = digitalPoKey(input.designStyleNo);
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify(["digital-order-style",styleKey])]);
      if ((await client.query("SELECT 1 FROM digital_production_orders WHERE translate(btrim(design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=$1 LIMIT 1", [styleKey])).rowCount)
        fail("该编号已有客户订单，请打开原档案继续办理");
      const now=this.now(),orderDateError=customerOrderDateError(input.orderDate,beijingCalendarDate(now));
      if(orderDateError)fail(orderDateError,400);
      const dateErrors = initialCustomerDateErrors(input.lines,minimumInitialCustomerDate(now));
      if (dateErrors.length) fail(dateErrors.join("；"),400);
      let merchandiserId = input.primaryMerchandiserId;
      const defaultMerchandiserId = (await client.query("SELECT default_merchandiser_id FROM digital_production_customers WHERE code=$1 FOR SHARE", [input.customerCode])).rows[0]?.default_merchandiser_id ?? null;
      if (!isDigitalLeader(actor) && merchandiserId !== undefined && merchandiserId !== defaultMerchandiserId) digitalForbidden();
      if (merchandiserId === undefined) merchandiserId = defaultMerchandiserId;
      if (merchandiserId && !await new DigitalProductionAccessPolicy(client).lockActiveRole(merchandiserId, "order_merchandiser")) fail("主跟单必须为在职有效订单跟单", 400);
      const root = await new ProductionOrderRootRepository(client).create(createdBy);
      const businessTime = this.businessClock ? await this.businessClock.read({ kind: "order", id: root.productionOrderId })
        : { now: now.toISOString(), scenarioId: null, revision: 0 };
      await client.query(`INSERT INTO digital_production_orders(production_order_id,source_id,customer_code,product_group,design_style_no,temporary_style_no,order_date,contract_delivery_date,created_by,creation_hash,primary_merchandiser_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [root.productionOrderId, sourceId, input.customerCode, input.productGroup, input.designStyleNo, input.temporaryStyleNo, input.orderDate, input.contractDeliveryDate, createdBy, digest(input), merchandiserId]);
      const creationEventId = await this.audit(client, actor, "digital_order_created", root.productionOrderId, null, { ...input, slaBusinessTime: businessTime });
      for (const [position, line] of input.lines.entries()) {
        const lineId = randomUUID();
        await client.query(`INSERT INTO digital_production_po_lines(line_id,production_order_id,position,po_number,formal_style_no,temporary_style_no,color,color_foreign,delivery_date)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [lineId, root.productionOrderId, position + 1, digitalFormalPoNo(line), digitalFormalPoNo(line), line.temporaryStyleNo, line.color, line.colorForeign, line.deliveryDate]);
        const customerDate = line.customerWarehouseArrivalDate === undefined ? line.deliveryDate : line.customerWarehouseArrivalDate;
        if (customerDate) await new DigitalPoDateRepository(client).applyWithClient(actor,root.productionOrderId,"initial_po",
          [{lineId,date:customerDate,expectedVersion:0}],creationEventId);
        for (const size of line.sizes) await client.query("INSERT INTO digital_production_po_sizes(line_id,size,quantity) VALUES($1,$2,$3)", [lineId, size.size, size.quantity]);
      }
      await new SlaOrderService(this.database).enrollNewOrder(client, actor, root.productionOrderId, creationEventId, businessTime);
      return this.readWith(client, actor, root.productionOrderId);
    });
  }
  async attachSource(actor: TrustedActorContext, id: string, sourceId: string, key: string): Promise<DigitalOrder> {
    return this.command(actor, `attach-source:${id}`, key, { sourceId }, async client => {
      const source = await this.visibleSource(client, actor, sourceId, true);
      const order = await this.visibleOrder(client, actor, id, true);
      if (!isDigitalLeader(actor) && !(actor.actorRoles.includes("sample_designer") && order.created_by === actor.actorId && source.created_by === actor.actorId)) digitalForbidden();
      if (order.source_id === sourceId) return this.readWith(client, actor, id);
      if (source.created_by !== order.created_by) fail("开发来源与订单必须归属同一设计师");
      if (order.source_id || order.design_style_no !== source.design_style_no || (order.temporary_style_no ?? "") !== (source.temporary_style_no ?? "") || (source.customer_code && source.customer_code !== order.customer_code)) fail("开发来源与订单不匹配或已有关联");
      const used = await client.query("SELECT 1 FROM digital_production_orders WHERE source_id=$1", [sourceId]);
      if (used.rowCount) fail("该开发来源已有履约母单");
      await client.query("UPDATE digital_production_orders SET source_id=$2,version=version+1 WHERE production_order_id=$1", [id, sourceId]);
      await this.audit(client, actor, "digital_source_attached", id, { sourceId: null }, { sourceId });
      return this.readWith(client, actor, id);
    });
  }
  async read(actor: TrustedActorContext, id: string): Promise<DigitalOrder> { assertIdentityActor(actor); return this.readWith(this.database, actor, id); }
  async slaPlan(actor: TrustedActorContext, id: string) { assertIdentityActor(actor); return new SlaOrderService(this.database, this.businessClock).read(actor, id); }
  async readWithClient(actor: TrustedActorContext, id: string, client: Pick<Pool, "query">): Promise<DigitalOrder> { assertIdentityActor(actor); return this.readWith(client, actor, id); }
  private async readWith(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, id: string): Promise<DigitalOrder> {
    const row = await this.visibleOrder(client, actor, id);
    const lines = await client.query(`SELECT l.line_id AS "lineId",l.po_number AS "poNumber",l.formal_style_no AS "formalStyleNo",l.temporary_style_no AS "temporaryStyleNo",
      l.color,l.color_foreign AS "colorForeign",COALESCE(l.customer_warehouse_arrival_date,l.delivery_date)::text AS "deliveryDate",
      l.customer_warehouse_arrival_date::text AS "customerWarehouseArrivalDate",l.factory_delivery_date::text AS "factoryDeliveryDate",
      l.customer_date_version AS "customerDateVersion",l.factory_date_version AS "factoryDateVersion",
      COALESCE(l.customer_date_source,'legacy_unregistered') AS "customerDateSource",
      COALESCE(l.factory_date_source,'legacy_unregistered') AS "factoryDateSource",
      (SELECT jsonb_agg(jsonb_build_object('size',s.size,'quantity',s.quantity) ORDER BY s.size) FROM digital_production_po_sizes s WHERE s.line_id=l.line_id) AS sizes
      FROM digital_production_po_lines l WHERE production_order_id=$1 ORDER BY position`, [id]);
    return { productionOrderId: id, sourceId: row.source_id, customerCode: row.customer_code, productGroup: row.product_group,
      designStyleNo: row.design_style_no, temporaryStyleNo: row.temporary_style_no, orderDate: digitalDateText(row.order_date)!, contractDeliveryDate: digitalDateText(row.contract_delivery_date),
      createdBy: row.created_by, createdAt: new Date(row.created_at).toISOString(), status: row.source_id ? "development_linked" : "waiting_development",
      version: row.version, primaryMerchandiserId: row.primary_merchandiser_id, workflowGeneration: "digital_production_v1", notificationPolicy: "IN_APP_ONLY", lines: lines.rows.map(line => {
        const values = [line.poNumber,line.formalStyleNo].map(digitalPoKey).filter(Boolean);
        const poIdentityConflict = new Set(values).size > 1;
        return {...line,formalPoNo:poIdentityConflict ? null : digitalFormalPoNo(line),poIdentityConflict};
      }) };
  }
  async orders(actor: TrustedActorContext, page: number, search: string): Promise<{ items: DigitalOrder[]; page: number }> {
    assertIdentityActor(actor);
    const rows = await this.database.query(`SELECT production_order_id FROM digital_production_orders o
      WHERE ${readScope("order", "o")} AND ($3='' OR strpos(lower(design_style_no),lower($3))>0 OR strpos(lower(coalesce(temporary_style_no,'')),lower($3))>0
        OR EXISTS(SELECT 1 FROM digital_production_po_lines l WHERE l.production_order_id=o.production_order_id AND
          (strpos(lower(coalesce(l.formal_style_no,'')),lower($3))>0 OR strpos(lower(coalesce(l.po_number,'')),lower($3))>0)))
      ORDER BY created_at DESC,production_order_id DESC LIMIT 15 OFFSET $4`, [isDigitalLeader(actor) || isDigitalTechnicalManager(actor), actor.actorId, search, (page - 1) * 15, actor.actorRoles.includes("sample_designer"), actor.actorRoles.includes("order_merchandiser"), actor.actorRoles.includes("development_clerk") && await new DigitalProductionAccessPolicy(this.database).activeRole(actor.actorId,"development_clerk")]);
    return { items: await Promise.all(rows.rows.map(row => this.readWith(this.database, actor, row.production_order_id))), page };
  }
  async correctNumbers(actor: TrustedActorContext, id: string, lineId: string, input: DigitalNumberCorrection, key: string): Promise<DigitalOrder> {
    const result=await this.command(actor, `numbers:${id}:${lineId}`, key, input, async client => {
      const order = await this.visibleOrder(client, actor, id, true);
      if (!isDigitalLeader(actor) && !(actor.actorRoles.includes("sample_designer") && order.created_by === actor.actorId) && !(actor.actorRoles.includes("order_merchandiser") && order.primary_merchandiser_id === actor.actorId)) digitalForbidden();
      if (order.version !== input.expectedVersion) fail("订单已更新，请刷新后重试");
      const line = await client.query("SELECT po_number,formal_style_no FROM digital_production_po_lines WHERE production_order_id=$1 AND line_id=$2", [id, lineId]);
      if (!line.rows[0]) fail("款色明细不存在", 404);
      const links=await client.query("SELECT 1 FROM digital_production_child_links WHERE production_order_id=$1 LIMIT 1",[id]);
      if(links.rowCount&&!this.sourcing)fail('关联单据编号同步服务尚未就绪');
      if (new Set([input.formalPoNo,input.poNumber,input.formalStyleNo].map(digitalPoKey).filter(Boolean)).size > 1)
        fail("正式款号（PO）只能有一个有效值",400);
      const duplicate = digitalFormalPoNo(input) ? await client.query(`SELECT 1 FROM digital_production_po_lines
        WHERE production_order_id=$1 AND line_id<>$2 AND normalize_sourcing_style_key($3::text)
          IN (normalize_sourcing_style_key(po_number),normalize_sourcing_style_key(formal_style_no)) LIMIT 1`,
        [id,lineId,digitalFormalPoNo(input)]) : null;
      if (duplicate?.rowCount) fail("同一母单正式款号（PO）不能重复",400);
      await client.query("UPDATE digital_production_po_lines SET po_number=$3,formal_style_no=$4 WHERE production_order_id=$1 AND line_id=$2", [id, lineId, digitalFormalPoNo(input), digitalFormalPoNo(input)]);
      await client.query("UPDATE digital_production_orders SET version=version+1 WHERE production_order_id=$1", [id]);
      if(links.rowCount)await this.sourcing!.reviseDigitalNumbersWithClient(client,actor,id);
      await this.audit(client, actor, "digital_numbers_corrected", id, line.rows[0], { lineId, ...input });
      return this.readWith(client, actor, id);
    });
    await this.sourcing?.generateDigitalNumberContracts(actor,id);
    return result;
  }
}
