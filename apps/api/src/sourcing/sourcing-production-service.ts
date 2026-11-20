import { hasWarehouseReceivingRole } from "@dx-rework/contracts";
import {assertFixedFactoryDispatch} from '../production-platform/fixed-factory-dispatch.js';
import { linkNewDigitalChild, resolveDigitalChild } from "../production-platform/child-link-repository.js";
import { DigitalProductionAccessPolicy } from "../production-platform/access-policy.js";
import { memberCanWriteModule } from "../access/member-module-policy.js";
import { productionNotExcluded, productionMerchandiserId } from "./production-visibility.js";
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import {
  DispatchSourcingOrderSchema,
  SourcingProductionOrderSchema,
  type DispatchSourcingOrder,
  type SourcingDispatchState,
  type SourcingProductionOrder,
  type PoDeliveryDate,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";

const ROOT = "root_superuser";
const WRITE = "sourcing:contract:record";
const READ = "sourcing:view";
const has = (actor: TrustedActorContext, capability: string): boolean => actor.actorRoles.includes(ROOT)
  || (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes(capability);
const fail = (message: string, status = 409): never => {
  throw new ApplicationError(status === 403 ? "FORBIDDEN" : status === 404 ? "NOT_FOUND" : "INVALID_STATE_TRANSITION", message, status);
};
const canWrite = (actor: TrustedActorContext, createdBy: string): boolean => actor.actorRoles.includes(ROOT)
  || (has(actor, WRITE) && actor.actorRoles.includes("order_merchandiser") && actor.actorId === createdBy);
const canReadOrders = (actor: TrustedActorContext): boolean => actor.actorRoles.includes(ROOT)
  || (has(actor, READ) && actor.actorRoles.some((role) => ["order_merchandiser", "production_management", "pmc", "owner_group"].includes(role)));
const readAll = (actor: TrustedActorContext): boolean => actor.actorRoles.some((role) => [ROOT, "production_management", "pmc", "owner_group"].includes(role));

type Source = {
  sourcing_case_id: string; created_by: string;
  sourcing_approval_snapshot_id: string | null;
  sourcing_contract_document_id: string | null; contract_status: string | null;
  workflow_generation: string | null;
};
export type ProductionRow = { production_order_id: string; dispatched_at: Date | string; status: SourcingProductionOrder["status"]; [key: string]: unknown };
const iso = (date: Date | string): string => new Date(date).toISOString();
// Correlated within the original authorized SELECT. Never serialize budget or price facts.
const selectPoDeliveryDates=`CASE WHEN to_jsonb(source_case)->>'workflow_generation'='digital_production_v1' THEN
 (SELECT jsonb_agg(jsonb_build_object('lineId',po.line_id,'position',mapped.child_line_key::integer,'poNumber',COALESCE(po.formal_style_no,po.po_number),'color',po.color,
 'customerWarehouseArrivalDate',to_jsonb(po)->>'customer_warehouse_arrival_date','factoryDeliveryDate',to_jsonb(po)->>'factory_delivery_date',
 'sampleTargetDate',((to_jsonb(po)->>'customer_warehouse_arrival_date')::date-COALESCE((
 SELECT (frozen.parameters_json#>>'{ship_sample_advance,value,days}')::integer
 FROM digital_sla_order_snapshots frozen WHERE frozen.production_order_id=mapped.production_order_id
 ORDER BY frozen.revision DESC LIMIT 1),10))::text) ORDER BY mapped.child_line_key::integer)
 FROM digital_production_child_lines mapped JOIN digital_production_po_lines po ON po.production_order_id=mapped.production_order_id AND po.line_id=mapped.line_id
 WHERE mapped.module='production' AND mapped.child_id=production.production_order_id) END AS po_delivery_dates`;
const selectPoDeliveryClosed=`CASE WHEN to_jsonb(source_case)->>'workflow_generation'='digital_production_v1' THEN EXISTS(
 SELECT 1 FROM digital_production_child_links link WHERE link.module='production' AND link.child_id=production.production_order_id
 AND (EXISTS(SELECT 1 FROM digital_order_closures closure WHERE closure.production_order_id=link.production_order_id)
 OR EXISTS(SELECT 1 FROM digital_production_resource_lifecycle lifecycle WHERE lifecycle.resource_kind='order' AND lifecycle.resource_id=link.production_order_id AND lifecycle.state='cancelled'))
) END AS po_delivery_closed`;
// Only explicit production fields are projected. Never serialize an approval row.
export const selectProduction = `SELECT production.production_order_id,production.sourcing_case_id,${selectPoDeliveryDates},${selectPoDeliveryClosed},
  production.decision_version,production.sourcing_contract_document_id,
  sourcing_contract_display_number(production.sourcing_contract_document_id,production.contract_number) AS contract_number,
  production.contract_version,production.supplier_id,production.supplier_name_snapshot,
  production.gender,production.style_name_snapshot,production.quantity,production.processes,
  sourcing_effective_delivery_date(production.sourcing_case_id,production.delivery_date)::text AS delivery_date,
  sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,production.dispatched_by,production.dispatched_at,
  transition.status,source_case.deleted_at IS NOT NULL AS source_case_archived,
  (SELECT COALESCE(sum(quantity),0)::integer FROM effective_sourcing_production_reports
    WHERE production_order_id=production.production_order_id) AS completed_quantity,
  (SELECT min(business_date)::text FROM effective_sourcing_production_reports
    WHERE production_order_id=production.production_order_id AND quantity>0) AS first_reported_on,
  (SELECT jsonb_agg(jsonb_build_object('position',line.position,'styleNo',identity.style_no,
    'alternateStyleNo',identity.alternate_style_no,'color',line.color,'quantity',line.quantity,
    'completedQuantity',(SELECT COALESCE(sum(quantity),0)::integer FROM effective_sourcing_production_reports
      WHERE production_order_id=line.production_order_id AND position=line.position)) ORDER BY line.position)
   FROM sourcing_production_lines line JOIN current_sourcing_case_lines identity ON identity.sourcing_case_id=production.sourcing_case_id AND identity.position=line.position WHERE line.production_order_id=production.production_order_id) AS lines
  FROM sourcing_production_orders production
  JOIN sourcing_cases source_case USING(sourcing_case_id)
  JOIN LATERAL (SELECT sourcing_factory_order_status(production.production_order_id) AS status) transition ON true`;
const factoryProductionFrom=(relation:'sourcing_production_factory_orders'|'dashboard_page'='sourcing_production_factory_orders')=>` FROM ${relation} production JOIN sourcing_cases source_case USING(sourcing_case_id)
 JOIN LATERAL (SELECT status FROM sourcing_production_transitions transition WHERE transition.production_order_id=production.production_order_id
  AND transition.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id ORDER BY sequence DESC LIMIT 1) transition ON true`;

export function selectFactoryDashboardCandidates(withPoDeadlines:boolean,withPrevious:boolean){
 const firstStyle=withPrevious?"sourcing_current_first_style(production.sourcing_case_id)":"NULL";
 return `SELECT production.production_order_id,production.factory_decision_id,production.sourcing_case_id,production.quantity,production.supplier_id,
  production.supplier_name_snapshot,production.delivery_date::text AS delivery_date,transition.status,
  ${firstStyle} AS first_style_no
  ${withPoDeadlines?`,${selectPoDeliveryDates},${selectPoDeliveryClosed}`:""}
  ${factoryProductionFrom()}`;
}

/** Each factory is an execution of the same order; no new production or actual quantity ledger. */
const factoryProjection=(relation:'sourcing_production_factory_orders'|'dashboard_page')=>`SELECT production.*,${selectPoDeliveryDates},${selectPoDeliveryClosed},sourcing_contract_display_number(production.sourcing_contract_document_id,production.contract_number) AS contract_number,
 source_case.deleted_at IS NOT NULL AS source_case_archived,transition.status,
 sourcing_current_first_style(production.sourcing_case_id) AS first_style_no,
 production.delivery_date::text AS delivery_date,
 (SELECT COALESCE(sum(completed_quantity),0)::integer FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id)) AS completed_quantity,
 (SELECT min(business_date)::text FROM effective_sourcing_production_reports report WHERE report.production_order_id=production.production_order_id
  AND report.factory_decision_id IS NOT DISTINCT FROM production.factory_decision_id AND quantity>0) AS first_reported_on,
 (SELECT jsonb_agg(jsonb_build_object('position',line.position,'styleNo',identity.style_no,'alternateStyleNo',identity.alternate_style_no,
  'color',line.color,'quantity',allocation.quantity,'completedQuantity',allocation.completed_quantity) ORDER BY line.position)
  FROM sourcing_production_lines line JOIN current_sourcing_case_lines identity ON identity.sourcing_case_id=production.sourcing_case_id AND identity.position=line.position
  JOIN sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation ON allocation.position=line.position
  WHERE line.production_order_id=production.production_order_id) AS lines
 ${factoryProductionFrom(relation)}`;

export const selectFactoryProduction=factoryProjection('sourcing_production_factory_orders');
export const selectFactoryDashboardPage=factoryProjection('dashboard_page');

export const toOrder = (row: ProductionRow): SourcingProductionOrder => SourcingProductionOrderSchema.parse({
  ...(row.factory_decision_id===undefined?{}:{factoryDecisionId:row.factory_decision_id}),
  productionOrderId: row.production_order_id, sourcingCaseId: row.sourcing_case_id, sourceCaseArchived: row.source_case_archived,
  decisionVersion: Number(row.decision_version), sourcingContractDocumentId: row.sourcing_contract_document_id,
  contractNumber: row.contract_number, contractVersion: Number(row.contract_version),
  supplierId: row.supplier_id, supplierName: row.supplier_name_snapshot,
  gender: row.gender, styleName: row.style_name_snapshot, quantity: Number(row.quantity),
  completedQuantity: Number(row.completed_quantity ?? 0),
  processes: row.processes, deliveryDate: row.delivery_date, firstStyleNo: row.first_style_no,
  ...(row.po_delivery_dates?{poDeliveryDates:row.po_delivery_dates as PoDeliveryDate[]}:{}),
  ...(row.po_delivery_closed!==null&&row.po_delivery_closed!==undefined?{poDeliveryClosed:Boolean(row.po_delivery_closed)}:{}),
  dispatchedBy: row.dispatched_by, dispatchedAt: iso(row.dispatched_at), status: row.status,
  firstReportedOn: row.first_reported_on ?? null, reportingState: row.status === "in_production" && !row.first_reported_on ? "pending_first_report" : null, timeProgress: null, progressAlert: null,
  lines: row.lines,
});

export class SourcingProductionService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  private async source(client: Pick<PoolClient, "query">, sourcingCaseId: string, lock = false): Promise<Source> {
    // Acquire the case lock before reading joined facts, so a concurrent approval
    // or factory change cannot leave this request with a pre-lock decision snapshot.
    if (lock) await client.query("SELECT sourcing_case_id FROM sourcing_cases WHERE sourcing_case_id=$1 FOR UPDATE", [sourcingCaseId]);
    const result = await client.query<Source>(`SELECT source_case.sourcing_case_id,source_case.created_by,
      snapshot.sourcing_approval_snapshot_id,document.sourcing_contract_document_id,document.status AS contract_status,
      to_jsonb(source_case)->>'workflow_generation' AS workflow_generation
      FROM sourcing_cases source_case
      LEFT JOIN LATERAL (SELECT sourcing_decision_id FROM sourcing_decisions
        WHERE sourcing_case_id=source_case.sourcing_case_id ORDER BY decision_version DESC LIMIT 1) decision ON true
      LEFT JOIN sourcing_approval_snapshots snapshot ON snapshot.sourcing_decision_id=decision.sourcing_decision_id
      LEFT JOIN LATERAL (SELECT * FROM sourcing_contract_documents WHERE sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id ORDER BY contract_version DESC LIMIT 1) document ON true
      WHERE source_case.sourcing_case_id=$1 AND source_case.deleted_at IS NULL
      `, [sourcingCaseId]);
    return result.rows[0] ?? fail("外发订单不存在", 404);
  }

  async state(actor: TrustedActorContext, sourcingCaseId: string): Promise<SourcingDispatchState> {
    if (!has(actor, READ)) fail("无权查看派单状态", 403);
    const source = await this.source(this.database, sourcingCaseId);
    const result = await this.database.query<ProductionRow>(`${selectProduction}
      WHERE production.sourcing_case_id=$1`, [sourcingCaseId]);
    const row = result.rows[0];
    const digital = source.workflow_generation === "digital_production_v1";
    return {
      item: row ? { productionOrderId: row.production_order_id, status: row.status, dispatchedAt: iso(row.dispatched_at) } : null,
      canDispatch: !row && !digital && await memberCanWriteModule(this.database, actor.actorId, "sourcing") && canWrite(actor, source.created_by) && source.contract_status === "ready",
      dispatchMode: digital ? "warehouse_actual_dispatch" : "merchandiser",
    };
  }

  async dispatch(actor: TrustedActorContext, sourcingCaseId: string, input: DispatchSourcingOrder, key: string) {
    const parsed = DispatchSourcingOrderSchema.safeParse(input);
    if (!parsed.success || !/^[A-Za-z0-9._:-]{1,200}$/.test(key)) {
      throw new ApplicationError("VALIDATION_ERROR", "请确认派单信息后提交", 400);
    }
    if (!has(actor, WRITE) || (!actor.actorRoles.includes(ROOT) && !actor.actorRoles.includes("order_merchandiser"))) {
      fail("仅本订单跟单或 Root 可正式派单", 403);
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const generation=(await client.query("SELECT to_jsonb(sourcing_cases)->>'workflow_generation' AS generation FROM sourcing_cases WHERE sourcing_case_id=$1",[sourcingCaseId])).rows[0]?.generation;
      if(generation==='digital_production_v1')fail('新数字单由仓库完成整款实际发厂后自动接入生产');
      const source = await this.source(client, sourcingCaseId, true);
      if (!canWrite(actor, source.created_by)) fail("仅本订单跟单或 Root 可正式派单", 403);
      const scope = "sourcing.production.dispatch";
      const outcome = await this.idempotency.execute(client, {
        scope, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify({ sourcingCaseId, input: parsed.data })).digest("hex"),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        return this.dispatchWithClient(client,actor,sourcingCaseId,source,parsed.data.sourcingContractDocumentId);

      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused, statusCode: outcome.statusCode };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  private async dispatchWithClient(client:PoolClient,actor:TrustedActorContext,sourcingCaseId:string,source:Source,contractId:string,occurredAt?:string){
    const scope="sourcing.production.dispatch";
        // A changed contract cannot start a second execution of the same case.
        // Replays of the dispatched contract still return its immutable receipt.
        const existing = await client.query<ProductionRow>(`${selectProduction}
          WHERE production.sourcing_case_id=$1`, [sourcingCaseId]);
        const dispatched = existing.rows[0];
        if (dispatched) {
          if (dispatched.sourcing_contract_document_id !== contractId) {
            fail("本订单已正式派单，不能按新合同重复派单；余量转厂沿既有转厂流程执行");
          }
          return { statusCode: 200, response: toOrder(dispatched) };
        }
        if (!source.sourcing_approval_snapshot_id || source.contract_status !== "ready"
          || source.sourcing_contract_document_id !== contractId) {
          fail("请确认老板已批准、当前合同已生成，并刷新后重新确认派单");
        }
        const productionOrderId = randomUUID();
        const eventId = await this.events.append(client, { ...actor, authorizationCapability: WRITE }, {
          action: scope, entityType: "sourcing_production_order", entityId: productionOrderId,
          after: { sourcingCaseId, contractDocumentId: contractId, status: "in_production" },
          reason: "跟单确认供应商、数量、交期和合同后正式派单",
        });
        await client.query(`INSERT INTO sourcing_production_orders(
          production_order_id,sourcing_case_id,sourcing_approval_snapshot_id,sourcing_decision_id,decision_version,
          sourcing_contract_document_id,contract_number,contract_version,supplier_id,supplier_name_snapshot,
          gender,style_name_snapshot,quantity,processes,delivery_date,first_style_no,dispatched_by,operation_event_id,dispatched_at)
          SELECT $1,snapshot.sourcing_case_id,snapshot.sourcing_approval_snapshot_id,snapshot.sourcing_decision_id,snapshot.decision_version,
            document.sourcing_contract_document_id,document.contract_number,document.contract_version,
            snapshot.supplier_id,snapshot.supplier_name_snapshot,snapshot.gender,snapshot.style_name_snapshot,
            snapshot.quantity,snapshot.processes,snapshot.delivery_date,
            (SELECT style_no FROM sourcing_approval_snapshot_lines WHERE sourcing_approval_snapshot_id=snapshot.sourcing_approval_snapshot_id ORDER BY position LIMIT 1),$2,$3,coalesce($6::timestamptz,CURRENT_TIMESTAMP)
          FROM sourcing_approval_snapshots snapshot JOIN sourcing_contract_documents document USING(sourcing_approval_snapshot_id)
          WHERE snapshot.sourcing_approval_snapshot_id=$4 AND document.sourcing_contract_document_id=$5`,
        [productionOrderId, actor.actorId, eventId, source.sourcing_approval_snapshot_id, contractId,occurredAt??null]);
        await client.query(`INSERT INTO sourcing_production_lines(production_order_id,position,style_no,alternate_style_no,color,quantity)
          SELECT $1,position,style_no,alternate_style_no,color,quantity FROM sourcing_approval_snapshot_lines
          WHERE sourcing_approval_snapshot_id=$2 ORDER BY position`, [productionOrderId, source.sourcing_approval_snapshot_id]);
        await client.query(`INSERT INTO sourcing_production_transitions(
          production_transition_id,production_order_id,sequence,status,business_date,actor_id,operation_event_id)
          VALUES($1,$2,1,'in_production',(coalesce($5::timestamptz,CURRENT_TIMESTAMP) AT TIME ZONE 'Asia/Shanghai')::date,$3,$4)`,
        [randomUUID(), productionOrderId, actor.actorId, eventId,occurredAt??null]);
        const created = await client.query<ProductionRow>(`${selectProduction} WHERE production.production_order_id=$1`, [productionOrderId]);
        return { statusCode: 201, response: toOrder(created.rows[0]!) };
  }
  async dispatchDigitalWithClient(client:PoolClient,actor:TrustedActorContext,orderId:string,factId:string){
    const fact=(await client.query(`SELECT f.*,l.child_id AS sourcing_case_id FROM digital_factory_facts f JOIN digital_factory_routes r USING(preparation_id) JOIN digital_production_child_links l ON l.production_order_id=r.production_order_id AND l.module='sourcing' WHERE f.fact_id=$1 AND r.production_order_id=$2 AND f.kind='仓库实际发厂' AND f.actor_id=$3`,[factId,orderId,actor.actorId])).rows[0];
    if(!fact||!actor.actorRoles.includes(ROOT)&&(!hasWarehouseReceivingRole(actor.actorRoles)||!await new DigitalProductionAccessPolicy(client).activeRole(actor.actorId,'warehouse_receiver')))fail('发厂须匹配仓库实际登记事实',403);
    await assertFixedFactoryDispatch(client,orderId,fact);
    const source=await this.source(client,fact.sourcing_case_id,true);
    if(source.workflow_generation!=='digital_production_v1')fail('发厂事实与数字生产来源不一致');
    if(!source.sourcing_contract_document_id||source.contract_status!=='ready')fail('当前批准合同尚未就绪；请订单跟单在本单合同页处理已列缺项并等待文件生成，生成失败时按该页重试，不能用旧版合同派单');
    // A physical remainder is not a new production dispatch. Keep the first
    // execution's immutable contract, quantities and start, including after repricing.
    const existing=(await client.query<ProductionRow>(`${selectProduction} WHERE production.sourcing_case_id=$1`,[fact.sourcing_case_id])).rows[0];
    if(existing&&await resolveDigitalChild(client,'production',existing.production_order_id,'digital_production_v1')!==orderId)fail('生产执行与本单来源关联不一致');
    const result=existing?{response:toOrder(existing)}:await this.dispatchWithClient(client,actor,fact.sourcing_case_id,source,source.sourcing_contract_document_id!,iso(fact.occurred_at)!);
    const lines=(await client.query("SELECT child_line_key,line_id FROM digital_production_child_lines WHERE module='sourcing' AND child_id=$1 ORDER BY child_line_key",[fact.sourcing_case_id])).rows;
    await linkNewDigitalChild(client,{module:'production',childId:result.response.productionOrderId,productionOrderId:orderId,lines:lines.map(l=>({childLineKey:l.child_line_key,lineId:l.line_id}))});
    return result.response;
  }
  async get(actor: TrustedActorContext, productionOrderId: string): Promise<SourcingProductionOrder> {
    if (!canReadOrders(actor)) fail("无权查看生产订单", 403);
    const result = await this.database.query<ProductionRow>(`${selectProduction}
      WHERE production.production_order_id=$1 AND ${productionNotExcluded}
        AND ($2::boolean OR ${productionMerchandiserId}=$3)`, [productionOrderId, readAll(actor), actor.actorId]);
    return result.rows[0] ? toOrder(result.rows[0]) : fail("生产订单不存在或不在负责范围内", 404);
  }

  async list(actor: TrustedActorContext, page = 1) {
    if (!canReadOrders(actor)) fail("无权查看生产订单", 403);
    if (!Number.isInteger(page) || page < 1 || page > 100000) {
      throw new ApplicationError("VALIDATION_ERROR", "分页页码无效", 400);
    }
    const result = await this.database.query<ProductionRow>(`${selectProduction}
      WHERE ${productionNotExcluded} AND ($1::boolean OR ${productionMerchandiserId}=$2)
      ORDER BY production.dispatched_at DESC,production.production_order_id LIMIT 15 OFFSET $3`,
    [readAll(actor), actor.actorId, (page - 1) * 15]);
    const count = await this.database.query<{ total: string }>(`SELECT count(*)::text AS total
      FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id)
      WHERE ${productionNotExcluded} AND ($1::boolean OR ${productionMerchandiserId}=$2)`, [readAll(actor), actor.actorId]);
    return { items: result.rows.map(toOrder), page, pageSize: 15 as const, totalCount: Number(count.rows[0]?.total ?? 0) };
  }
}
