import { createHash, randomUUID } from "node:crypto";
import type {
  AllocateExternalSuppliers,
  ApproveExternalDeductionSpecialApproval,
  CloseExternalDeductionCase,
  CreateExternalDeductionEntry,
  CreateExternalDeductionFollowUp,
  CreateExternalResponsibilityRevision,
  DecideExternalResponsibilityRevision,
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
  ExternalResponsibilityQueueResponse,
  PayablesAcceptExternalResponsibilityCase,
  PayablesReturnExternalResponsibilityCase,
  RequestExternalDeductionSpecialApproval,
  ReturnExternalDeductionSpecialApproval,
  SubmitExternalResponsibilityCase,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type Queryable = Pool | PoolClient;
type Result<T> = { value: T; reused: boolean };
type ResponsibilityType = "processing_factory" | "embroidery_factory" | "washing_factory" | "fabric_supplier";
type CaseStatus = NonNullable<ExternalResponsibilityBatchResponse>["cases"][number]["status"];
type OrderRow = {
  rework_order_id: string; rework_no: string | null; status: string; version: number;
  style_no: string | null; order_no: string | null; merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null; processing_factory_supplier_version: number | null;
  problem_part: string | null; problem_description: string | null; rework_quantity: number | null;
};
type CaseRow = {
  case_id: string; batch_id: string; rework_order_id: string; responsibility_type: ResponsibilityType;
  supplier_id: string; supplier_version: number; supplier_code_snapshot: string; supplier_name_snapshot: string;
  supplier_type_snapshot: "factory" | "embroidery_washing" | "fabric"; business_handler_user_id: string;
  payables_handler_role_snapshot: string; proposed_deduction_amount: string; case_version: number;
  status: CaseStatus; batch_status: "active" | "superseded"; submitted_at: Date | null; payables_confirmed_at: Date | null;
};
const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const toIso = (value: Date | null): string | null => value ? value.toISOString() : null;
const payablesRole = (type: ResponsibilityType): string => ({
  processing_factory: "factory_payables", fabric_supplier: "fabric_payables",
  embroidery_factory: "embroidery_washing_payables", washing_factory: "embroidery_washing_payables",
})[type];
const toCents = (amount: string): bigint => {
  const normalized = amount.trim();
  const negative = normalized.startsWith("-");
  const unsigned = negative ? normalized.slice(1) : normalized;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0").slice(0, 2) || "0");
  return negative ? -cents : cents;
};
const money = (cents: bigint): string => {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  return `${negative ? "-" : ""}${absolute / 100n}.${(absolute % 100n).toString().padStart(2, "0")}`;
};
const jsonbParameter = (value: unknown): string =>
  JSON.stringify(typeof value === "string" ? JSON.parse(value) : value);

/**
 * N09 is intentionally based on the current finalized leaf and only N08-A/B
 * obligations.  It does not inspect N10 actual-deduction follow-up states.
 */
export async function maybeCompleteResponsibilityAction(
  client: PoolClient,
  actor: TrustedActorContext,
  order: OrderRow,
): Promise<boolean> {
  if (order.status !== "pending_responsibility_action") return false;
  const ready = await client.query<{ complete: boolean }>(
    `WITH current_determination AS (
       SELECT determination_id FROM rework_responsibility_determinations d
       WHERE d.rework_order_id=$1 AND d.stage='finalized'
         AND NOT EXISTS (SELECT 1 FROM rework_responsibility_determinations next WHERE next.replaces_determination_id=d.determination_id)
       ORDER BY determination_version DESC LIMIT 1
     ), external_required AS (
       SELECT item.external_item_id FROM rework_external_responsibility_items item
       JOIN rework_external_responsibility_batches batch ON batch.batch_id=item.batch_id
       JOIN current_determination current ON current.determination_id=batch.finalized_determination_id
       WHERE batch.status='active' AND item.proposed_amount>0
     )
     SELECT
       NOT EXISTS(
         SELECT 1 FROM rework_responsibility_allocations allocation
         JOIN current_determination current ON current.determination_id=allocation.determination_id
         WHERE allocation.responsibility_type='own_factory' AND allocation.rounded_amount>0
           AND NOT EXISTS(
             SELECT 1 FROM rework_own_factory_approvals approval
             WHERE approval.finalized_determination_id=current.determination_id AND approval.status='approved'
           )
       )
       AND NOT EXISTS(
         SELECT 1 FROM external_required required
         WHERE NOT EXISTS(
           SELECT 1 FROM rework_external_responsibility_case_items mapping
           JOIN rework_external_responsibility_cases deduction_case ON deduction_case.case_id=mapping.case_id
           WHERE mapping.external_item_id=required.external_item_id
             AND deduction_case.status IN ('deduction_follow_up','closed')
         )
       ) AS complete`,
    [order.rework_order_id],
  );
  if (!ready.rows[0]?.complete) return false;
  const events = new OperationEventRepository();
  const capability = actor.authorizationCapability === "own_factory:approve"
    ? "own_factory:approve"
    : actor.authorizationCapability === "external_responsibility:payables_confirm"
      ? "external_responsibility:payables_confirm"
      : "responsibility:determine";
  const eventId = await events.append(client, { ...actor, authorizationCapability: capability }, {
    action: "rework.responsibility.complete", entityType: "rework_order", entityId: order.rework_order_id,
    before: orderAudit(order), after: orderAudit(order, "completed", order.version + 1),
  });
  await client.query(
    `SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)`,
    [eventId, actor.requestId],
  );
  const updated = await client.query(
    `UPDATE rework_orders SET status='completed',version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP
     WHERE rework_order_id=$1 AND status='pending_responsibility_action'`,
    [order.rework_order_id, actor.actorId],
  );
  return updated.rowCount === 1;
}

const orderAudit = (order: OrderRow, status = order.status, version = order.version): Record<string, unknown> => ({
  reworkOrderId: order.rework_order_id, reworkNo: order.rework_no, status,
  styleNo: order.style_no, orderNo: order.order_no, merchandiserUserId: order.merchandiser_user_id,
  processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory"
    ? { type: "own_factory" }
    : { type: "supplier", supplierId: order.processing_factory_supplier_id, supplierVersion: order.processing_factory_supplier_version },
  problemPart: order.problem_part, problemDescription: order.problem_description,
  reworkQuantity: order.rework_quantity, version,
});

export class ExternalResponsibilityService {
  private readonly idempotency = new IdempotencyService();
  private readonly events = new OperationEventRepository();
  private readonly outbox = new MessageOutboxRepository();
  constructor(
    private readonly database: Pool,
    protected readonly todos?: TodoProjectionService,
  ) {}

  /** Called inside PR-09 finalization; no browser request can create a batch. */
  async ensureForFinalized(
    client: PoolClient, actor: TrustedActorContext, order: OrderRow, determinationId: string,
  ): Promise<string | null> {
    const source = await client.query<{
      determination_id: string; determination_version: number; operation_event_id: string; request_id: string; created_by: string; source_snapshot: Record<string, unknown>;
    }>(
      `SELECT d.determination_id,d.determination_version,d.operation_event_id,d.request_id,d.created_by,
        jsonb_build_object('finalizedDetermination',jsonb_build_object('determinationId',d.determination_id,'determinationVersion',d.determination_version,'sourceOrderReviewId',d.source_order_review_id,'calculationTotal',d.calculation_total::text),'order',jsonb_build_object('reworkOrderId',o.rework_order_id,'reworkNo',o.rework_no,'styleNo',o.style_no,'orderNo',o.order_no,'problemPart',o.problem_part,'problemDescription',o.problem_description),'qualityControl',jsonb_build_object('initiatedBy',o.created_by,'initiatedAt',to_char(o.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),'wholeOrderReview',jsonb_build_object('orderReviewId',review.order_review_id,'reviewedBy',review.reviewed_by,'reviewedAt',to_char(review.reviewed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'reviewSnapshot',review.review_snapshot)) source_snapshot
       FROM rework_responsibility_determinations d
       JOIN rework_orders o ON o.rework_order_id=d.rework_order_id
       JOIN rework_order_reviews review ON review.order_review_id=d.source_order_review_id
       WHERE d.determination_id=$1 AND d.rework_order_id=$2 AND d.stage='finalized'
         AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations successor WHERE successor.replaces_determination_id=d.determination_id)`,
      [determinationId, order.rework_order_id],
    );
    const finalized = source.rows[0];
    if (!finalized) return null;
    const existing = await client.query<{ batch_id: string }>(
      "SELECT batch_id FROM rework_external_responsibility_batches WHERE finalized_determination_id=$1", [determinationId],
    );
    if (existing.rows[0]) return existing.rows[0].batch_id;
    await this.supersedeReplacedBatches(client, order.rework_order_id, determinationId);
    const external = await client.query<{ configuration_item_id: string; responsibility_type: ResponsibilityType; process_snapshot: Record<string, unknown>; multiplier: string; share_bps: number; proposed_amount: string; amount_line_snapshot: Record<string, unknown> }>(
      `SELECT allocation.configuration_item_id,allocation.responsibility_type,
              jsonb_build_object('configurationItemId',process.configuration_item_id,'processName',process.process_name_snapshot,'pricingUnit',process.pricing_unit_snapshot,'baseAmount',process.base_amount::text,'responsibilityAmount',process.responsibility_amount::text) process_snapshot,
              process.multiplier::text multiplier,allocation.share_bps,allocation.rounded_amount::text proposed_amount,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('workReportId',line.work_report_id,'personId',line.person_id,'baseMemberShareAmount',line.base_member_share_amount::text,'multiplier',line.multiplier::text,'shareBps',line.share_bps,'roundedAmount',line.rounded_amount::text,'memberSnapshot',line.member_snapshot,'reportSnapshot',line.report_snapshot) ORDER BY line.work_report_id,line.person_id) FROM rework_responsibility_amount_lines line WHERE line.determination_id=allocation.determination_id AND line.configuration_item_id=allocation.configuration_item_id AND line.responsibility_type=allocation.responsibility_type),'[]'::jsonb) amount_line_snapshot
       FROM rework_responsibility_allocations allocation
       JOIN rework_responsibility_processes process USING(determination_id,configuration_item_id)
       WHERE allocation.determination_id=$1 AND allocation.responsibility_type<> 'own_factory' AND allocation.rounded_amount>0
       ORDER BY allocation.configuration_item_id,allocation.responsibility_type`,
      [determinationId],
    );
    if (external.rowCount === 0) return null;
    const batchId = randomUUID();
    await client.query(
      `INSERT INTO rework_external_responsibility_batches(batch_id,rework_order_id,finalized_determination_id,finalized_determination_version,source_snapshot,created_by,operation_event_id,request_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [batchId, order.rework_order_id, determinationId, finalized.determination_version, jsonbParameter(finalized.source_snapshot), finalized.created_by, finalized.operation_event_id, finalized.request_id],
    );
    for (const item of external.rows) {
      await client.query(
        `INSERT INTO rework_external_responsibility_items(external_item_id,batch_id,determination_id,configuration_item_id,responsibility_type,process_snapshot,multiplier_snapshot,share_bps_snapshot,proposed_amount,amount_line_snapshot,operation_event_id,request_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [randomUUID(), batchId, determinationId, item.configuration_item_id, item.responsibility_type, jsonbParameter(item.process_snapshot), item.multiplier, item.share_bps, item.proposed_amount, jsonbParameter(item.amount_line_snapshot), finalized.operation_event_id, finalized.request_id],
      );
    }
    return batchId;
  }

  /** A successor responsibility leaf makes every directly replaced N08-B batch historical. */
  private async supersedeReplacedBatches(client: PoolClient, orderId: string, successorDeterminationId: string): Promise<void> {
    const stale = await client.query<{ batch_id: string }>(
      `SELECT batch.batch_id
       FROM rework_external_responsibility_batches batch
       JOIN rework_responsibility_determinations successor
         ON successor.determination_id=$2
        AND successor.replaces_determination_id=batch.finalized_determination_id
       WHERE batch.rework_order_id=$1 AND batch.status='active'
       FOR UPDATE OF batch`,
      [orderId, successorDeterminationId],
    );
    for (const batch of stale.rows) {
      await client.query(
        `UPDATE rework_external_responsibility_cases
         SET status='superseded',case_version=case_version+1
         WHERE batch_id=$1 AND status NOT IN ('closed','superseded')`,
        [batch.batch_id],
      );
      await client.query(
        "UPDATE rework_external_responsibility_batches SET status='superseded',batch_version=batch_version+1 WHERE batch_id=$1",
        [batch.batch_id],
      );
    }
  }

  async listQueue(actor: TrustedActorContext): Promise<ExternalResponsibilityQueueResponse> {
    const result = await this.database.query<{
      case_id: string; rework_order_id: string; rework_no: string | null; style_no: string | null; order_no: string | null; problem_part: string | null; responsibility_type: ResponsibilityType; supplier_name_snapshot: string; status: CaseStatus; proposed_deduction_amount: string; actual_deducted_amount: string; remaining_amount: string; case_version: number; overdue: boolean; can_act: boolean;
    }>(
      `SELECT c.case_id,c.rework_order_id,o.rework_no,o.style_no,o.order_no,o.problem_part,c.responsibility_type,c.supplier_name_snapshot,c.status,c.proposed_deduction_amount::text,
              COALESCE((SELECT sum(entry.amount) FROM rework_external_deduction_entries entry WHERE entry.case_id=c.case_id),0)::text actual_deducted_amount,
              (c.proposed_deduction_amount-COALESCE((SELECT sum(entry.amount) FROM rework_external_deduction_entries entry WHERE entry.case_id=c.case_id),0))::text remaining_amount,
              c.case_version,
              EXISTS(SELECT 1 FROM rework_external_deduction_follow_ups follow WHERE follow.case_id=c.case_id AND follow.next_follow_up_at<CURRENT_TIMESTAMP) overdue,
              (external_responsibility_can_sign($1,c.rework_order_id,c.responsibility_type)
                OR external_responsibility_can_payables($1,c.rework_order_id,c.responsibility_type)
                OR (c.status='pending_special_approval' AND external_responsibility_direct_role($1,'external_deduction:special_approve',ARRAY['finance_director']))) can_act
       FROM rework_external_responsibility_cases c
       JOIN rework_external_responsibility_batches batch ON batch.batch_id=c.batch_id
       JOIN rework_orders o ON o.rework_order_id=c.rework_order_id
       WHERE batch.status='active' AND c.status<>'superseded'
         AND external_responsibility_can_view_case($1,c.rework_order_id,c.responsibility_type)
       ORDER BY CASE c.status WHEN 'pending_business_signoff' THEN 1 WHEN 'returned' THEN 2 WHEN 'pending_payables_confirmation' THEN 3 WHEN 'deduction_follow_up' THEN 4 ELSE 5 END,c.created_at`,
      [actor.actorId],
    );
    return { items: result.rows.map((row) => ({
      caseId: row.case_id, reworkOrderId: row.rework_order_id, reworkNo: row.rework_no, styleNo: row.style_no, orderNo: row.order_no, problemPart: row.problem_part,
      responsibilityType: row.responsibility_type, supplierName: row.supplier_name_snapshot, status: row.status,
      proposedDeductionAmount: row.proposed_deduction_amount, actualDeductedAmount: row.actual_deducted_amount, remainingAmount: row.remaining_amount,
      caseVersion: row.case_version, overdue: row.overdue, canAct: row.can_act,
    })) };
  }

  async get(actor: TrustedActorContext, orderId: string, executor: Queryable = this.database): Promise<ExternalResponsibilityBatchResponse> {
    const allowed = await executor.query<{ permitted: boolean }>("SELECT external_responsibility_can_view($1,$2) permitted", [actor.actorId, orderId]);
    if (!allowed.rows[0]?.permitted) fail("当前用户无权查看外部责任台账", 403, "FORBIDDEN");
    const batch = await executor.query<{ batch_id: string; rework_order_id: string; finalized_determination_id: string; finalized_determination_version: number; batch_version: number; status: "active" | "superseded"; source_snapshot: Record<string, unknown> }>(
      `SELECT batch_id,rework_order_id,finalized_determination_id,finalized_determination_version,batch_version,status,source_snapshot
       FROM rework_external_responsibility_batches WHERE rework_order_id=$1 AND status='active'
       ORDER BY created_at DESC LIMIT 1`, [orderId],
    );
    const head = batch.rows[0];
    if (!head) return null;
    const items = await executor.query<{ external_item_id: string; configuration_item_id: string; responsibility_type: ResponsibilityType; process_snapshot: Record<string, unknown>; multiplier_snapshot: string; share_bps_snapshot: number; proposed_amount: string; amount_line_snapshot: Record<string, unknown> }>(
      `SELECT item.external_item_id,item.configuration_item_id,item.responsibility_type,item.process_snapshot,item.multiplier_snapshot::text,item.share_bps_snapshot,item.proposed_amount::text,item.amount_line_snapshot
       FROM rework_external_responsibility_items item
       WHERE item.batch_id=$1 AND (
         external_responsibility_can_view_all($2)
         OR external_responsibility_can_sign($2,$3,item.responsibility_type)
         OR EXISTS(
           SELECT 1 FROM rework_external_responsibility_case_items mapping
           JOIN rework_external_responsibility_cases target_case ON target_case.case_id=mapping.case_id
           WHERE mapping.external_item_id=item.external_item_id
             AND external_responsibility_can_view_case($2,target_case.rework_order_id,target_case.responsibility_type)
         )
       ) ORDER BY item.configuration_item_id,item.responsibility_type`, [head.batch_id,actor.actorId,orderId],
    );
    const cases = await executor.query<CaseRow>(
      `SELECT target_case.case_id,target_case.batch_id,target_case.rework_order_id,target_case.responsibility_type,target_case.supplier_id,target_case.supplier_version,target_case.supplier_code_snapshot,target_case.supplier_name_snapshot,target_case.supplier_type_snapshot,target_case.business_handler_user_id,target_case.payables_handler_role_snapshot,target_case.proposed_deduction_amount::text,target_case.case_version,target_case.status,batch.status batch_status,target_case.submitted_at,target_case.payables_confirmed_at
       FROM rework_external_responsibility_cases target_case JOIN rework_external_responsibility_batches batch USING(batch_id) WHERE target_case.batch_id=$1
         AND external_responsibility_can_view_case($2,rework_order_id,responsibility_type)
       ORDER BY created_at,case_id`, [head.batch_id,actor.actorId],
    );
    return {
      batchId: head.batch_id, reworkOrderId: head.rework_order_id, finalizedDeterminationId: head.finalized_determination_id,
      finalizedDeterminationVersion: head.finalized_determination_version, batchVersion: head.batch_version,
      status: head.status, sourceSnapshot: head.source_snapshot,
      items: items.rows.map((item) => this.itemDto(item)),
      cases: await Promise.all(cases.rows.map((item) => this.caseDto(actor, item, executor))),
    };
  }

  async getCase(actor: TrustedActorContext, caseId: string, executor: Queryable = this.database): Promise<ExternalResponsibilityCaseResponse> {
    const found = await executor.query<CaseRow>(
      `SELECT target_case.case_id,target_case.batch_id,target_case.rework_order_id,target_case.responsibility_type,target_case.supplier_id,target_case.supplier_version,target_case.supplier_code_snapshot,target_case.supplier_name_snapshot,target_case.supplier_type_snapshot,target_case.business_handler_user_id,target_case.payables_handler_role_snapshot,target_case.proposed_deduction_amount::text,target_case.case_version,target_case.status,batch.status batch_status,target_case.submitted_at,target_case.payables_confirmed_at FROM rework_external_responsibility_cases target_case JOIN rework_external_responsibility_batches batch USING(batch_id) WHERE target_case.case_id=$1`, [caseId],
    );
    const row = found.rows[0] ?? fail("外部责任台账不存在", 404, "NOT_FOUND");
    const permission = await executor.query<{ permitted: boolean }>("SELECT external_responsibility_can_view_case($1,$2,$3) permitted", [actor.actorId, row.rework_order_id,row.responsibility_type]);
    if (!permission.rows[0]?.permitted) fail("当前用户无权查看外部责任台账", 403, "FORBIDDEN");
    return this.caseDto(actor, row, executor);
  }

  allocateSuppliers(actor: TrustedActorContext, batchId: string, input: AllocateExternalSuppliers, key: string): Promise<Result<ExternalResponsibilityBatchResponse>> {
    return this.mutate(actor, "rework.external_responsibility.allocate", key, { batchId, input }, 201, async (client) => {
      const batch = await client.query<{ rework_order_id: string; batch_version: number; status: string }>("SELECT rework_order_id,batch_version,status FROM rework_external_responsibility_batches WHERE batch_id=$1 FOR UPDATE", [batchId]);
      const head = batch.rows[0] ?? fail("外部责任批次不存在", 404, "NOT_FOUND");
      if (head.status !== "active" || head.batch_version !== input.expectedBatchVersion) fail("外部责任批次版本冲突");
      const order = await this.order(client, head.rework_order_id, true);
      if (order.status !== "pending_responsibility_action") fail("返工单不在责任处理状态", 409, "INVALID_STATE_TRANSITION");
      const eventId = await this.event(client, actor, "rework.external_responsibility.allocate", "external_responsibility:sign", order);
      for (const allocation of input.allocations) {
        const items = await client.query<{ external_item_id: string; responsibility_type: ResponsibilityType }>(
          `SELECT item.external_item_id,item.responsibility_type FROM rework_external_responsibility_items item
           WHERE item.batch_id=$1 AND item.external_item_id=ANY($2::uuid[]) FOR UPDATE`, [batchId, allocation.externalItemIds],
        );
        if (items.rowCount !== allocation.externalItemIds.length || items.rows.some((item) => item.responsibility_type !== allocation.responsibilityType)) fail("外部责任项目不属于所选责任类型", 400, "VALIDATION_ERROR");
        const assigned = await client.query("SELECT 1 FROM rework_external_responsibility_case_items WHERE external_item_id=ANY($1::uuid[])", [allocation.externalItemIds]);
        if (assigned.rowCount) fail("外部责任项目已经分配给供应商");
        if (!await this.canSign(client, actor.actorId, order.rework_order_id, allocation.responsibilityType)) fail("当前用户不能为该责任类型签收", 403, "FORBIDDEN");
        if (allocation.responsibilityType === "processing_factory" && order.processing_factory_type === "supplier" && allocation.supplierId !== order.processing_factory_supplier_id && !allocation.processingFactoryOverrideReason) fail("改选其他加工厂必须填写原因", 400, "VALIDATION_ERROR");
        const supplier = await client.query<{ supplier_code: string; supplier_name: string; supplier_type: "factory" | "embroidery_washing" | "fabric"; version: number }>("SELECT supplier_code,supplier_name,supplier_type,version FROM current_supplier_catalog WHERE supplier_id=$1 AND active=true", [allocation.supplierId]);
        const selected = supplier.rows[0] ?? fail("供应商不存在或已停用", 400, "VALIDATION_ERROR");
        const expected = allocation.responsibilityType === "processing_factory" ? "factory" : allocation.responsibilityType === "fabric_supplier" ? "fabric" : "embroidery_washing";
        if (selected.supplier_type !== expected) fail("供应商类型与责任类型不匹配", 400, "VALIDATION_ERROR");
        const total = await client.query<{ total: string }>("SELECT COALESCE(sum(proposed_amount),0)::text total FROM rework_external_responsibility_items WHERE external_item_id=ANY($1::uuid[])", [allocation.externalItemIds]);
        const caseId = randomUUID();
        await client.query(
          `INSERT INTO rework_external_responsibility_cases(case_id,batch_id,rework_order_id,responsibility_type,supplier_id,supplier_version,supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot,business_handler_user_id,payables_handler_role_snapshot,proposed_deduction_amount,created_by,operation_event_id,request_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$10,$13,$14)`,
          [caseId,batchId,order.rework_order_id,allocation.responsibilityType,allocation.supplierId,selected.version,selected.supplier_code,selected.supplier_name,selected.supplier_type,actor.actorId,payablesRole(allocation.responsibilityType),total.rows[0]!.total,eventId,actor.requestId],
        );
        for (const itemId of allocation.externalItemIds) await client.query(
          `INSERT INTO rework_external_responsibility_case_items(case_id,external_item_id,operation_event_id,request_id) VALUES($1,$2,$3,$4)`, [caseId,itemId,eventId,actor.requestId],
        );
        await this.outbox.enqueue(client, { topic: "rework.external_responsibility.pending_business_signoff", aggregateType: "external_responsibility_case", aggregateId: caseId, recipientKey: actor.actorId, idempotencyKey: `external-case:pending-business:${caseId}`, payload: { caseId, reworkOrderId: order.rework_order_id, delivery: "intent_only" } });
      }
      await client.query("UPDATE rework_external_responsibility_batches SET batch_version=batch_version+1 WHERE batch_id=$1",[batchId]);
      return this.get(actor, order.rework_order_id, client);
    });
  }

  submit(actor: TrustedActorContext, caseId: string, input: SubmitExternalResponsibilityCase, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor, "rework.external_responsibility.submit", key, { caseId,input }, 200, async (client) => {
      const current = await this.lockCase(client, caseId); const order = await this.order(client,current.rework_order_id,true);
      this.requireCaseVersion(current,input.expectedCaseVersion); this.requireStatus(current,["pending_business_signoff","returned"]);
      if (!await this.canSign(client,actor.actorId,order.rework_order_id,current.responsibility_type)) fail("当前用户无权提交业务签收",403,"FORBIDDEN");
      await this.readyAttachments(client,input.attachmentIds); const eventId=await this.event(client,actor,"rework.external_responsibility.submit","external_responsibility:sign",order); await this.bindAttachments(client,actor,caseId,input.attachmentIds);
      await client.query(`INSERT INTO rework_external_business_signoffs(signoff_id,case_id,action,submitted_by,actor_role_snapshot,remark,attachment_ids,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),caseId,current.status==="returned"?"resubmitted":"submitted",actor.actorId,this.roles(actor),input.remark??null,input.attachmentIds,eventId,actor.requestId]);
      await client.query("UPDATE rework_external_responsibility_cases SET status='pending_payables_confirmation',case_version=case_version+1,submitted_at=CURRENT_TIMESTAMP WHERE case_id=$1",[caseId]);
      await this.outbox.enqueue(client,{topic:"rework.external_responsibility.pending_payables",aggregateType:"external_responsibility_case",aggregateId:caseId,recipientKey:payablesRole(current.responsibility_type),idempotencyKey:`external-case:pending-payables:${caseId}:${current.case_version+1}`,payload:{caseId,reworkOrderId:order.rework_order_id,delivery:"intent_only"}});
      await this.todos?.completeOpenByDedupeKey(client,actor,`external-signoff:${caseId}:${current.case_version}`,"External business signoff was submitted");
      if(current.status==="returned") {
        await this.todos?.completeOpenByDedupePrefix(client,actor,`external-return:${caseId}:`,"Returned external responsibility was resubmitted");
      }
      await this.todos?.actionableForUniqueRoleOrOrderDelegate(client,actor,{
        category:"external_payables_confirmation",sourceEventId:eventId,sourceAction:"rework.external_responsibility.submit",
        entityType:"rework_order",entityId:order.rework_order_id,requiredRole:current.payables_handler_role_snapshot,
        requiredCapability:"external_responsibility:payables_confirm",delegationScopeId:order.rework_order_id,
        route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},policyKey:"general",
        dedupeKey:`external-payables:${caseId}:${current.case_version+1}`,
      });
      await this.todos?.information(client,actor,{
        category:"external_business_signoff_submitted",sourceEventId:eventId,sourceAction:"rework.external_responsibility.submit",
        entityType:"rework_order",entityId:order.rework_order_id,recipientUserId:actor.actorId,
        route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},
        dedupeKey:`external-signoff-submitted:${caseId}:${current.case_version+1}:${actor.actorId}`,
      });
      return this.getCase(actor,caseId,client);
    });
  }

  payablesAccept(actor: TrustedActorContext, caseId: string, input: PayablesAcceptExternalResponsibilityCase, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.payablesDecision(actor,caseId,input.expectedCaseVersion,"accepted",null,[],key);
  }
  payablesReturn(actor: TrustedActorContext, caseId: string, input: PayablesReturnExternalResponsibilityCase, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.payablesDecision(actor,caseId,input.expectedCaseVersion,"returned",input.reason,input.attachmentIds,key);
  }

  followUp(actor: TrustedActorContext, caseId: string, input: CreateExternalDeductionFollowUp, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,"rework.external_deduction.follow_up",key,{caseId,input},201,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,input.expectedCaseVersion); this.requireStatus(current,["deduction_follow_up"]);
      const permitted=await this.canSign(client,actor.actorId,order.rework_order_id,current.responsibility_type)||await this.canPayables(client,actor.actorId,order.rework_order_id,current.responsibility_type);
      if(!permitted) fail("当前用户无权跟进扣款",403,"FORBIDDEN"); await this.readyAttachments(client,input.attachmentIds); const eventId=await this.event(client,actor,"rework.external_deduction.follow_up","external_deduction:follow_up",order); await this.bindAttachments(client,actor,caseId,input.attachmentIds);
      await client.query(`INSERT INTO rework_external_deduction_follow_ups(follow_up_id,case_id,content,supplier_feedback,next_follow_up_at,attachment_ids,created_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),caseId,input.content,input.supplierFeedback??null,input.nextFollowUpAt??null,input.attachmentIds,actor.actorId,eventId,actor.requestId]);
      await this.todos?.cancelOpenByDedupePrefix(client,actor,`deduction-overdue:${caseId}:`,"A newer formal deduction follow-up deadline superseded the prior overdue notice");
      return this.getCase(actor,caseId,client);
    });
  }

  recordDeduction(actor: TrustedActorContext, caseId: string, input: CreateExternalDeductionEntry, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,"rework.external_deduction.record",key,{caseId,input},201,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,input.expectedCaseVersion); this.requireStatus(current,["deduction_follow_up"]);
      if(!await this.canPayables(client,actor.actorId,order.rework_order_id,current.responsibility_type)) fail("当前用户无权记录实际扣款",403,"FORBIDDEN"); await this.readyAttachments(client,input.attachmentIds); const eventId=await this.event(client,actor,"rework.external_deduction.record","external_deduction:record",order); await this.bindAttachments(client,actor,caseId,input.attachmentIds);
      await client.query(`INSERT INTO rework_external_deduction_entries(deduction_entry_id,case_id,entry_type,amount,deducted_on,reference_no,attachment_ids,reverses_entry_id,recorded_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),caseId,input.entryType,input.amount,input.deductedOn,input.referenceNo??null,input.attachmentIds,input.reversesEntryId??null,actor.actorId,eventId,actor.requestId]);
      return this.getCase(actor,caseId,client);
    });
  }

  close(actor: TrustedActorContext, caseId: string, input: CloseExternalDeductionCase, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,"rework.external_deduction.close",key,{caseId,input},200,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,input.expectedCaseVersion); this.requireStatus(current,["deduction_follow_up"]);
      if(!await this.canPayables(client,actor.actorId,order.rework_order_id,current.responsibility_type)) fail("当前用户无权关闭扣款台账",403,"FORBIDDEN"); await this.readyAttachments(client,input.evidenceAttachmentIds);
      const ledger=(await client.query<{actual:string;is_full:boolean}>(
        `SELECT COALESCE(sum(entry.amount),0)::text actual,
                COALESCE(sum(entry.amount),0)=case_record.proposed_deduction_amount is_full
         FROM rework_external_responsibility_cases case_record
         LEFT JOIN rework_external_deduction_entries entry ON entry.case_id=case_record.case_id
         WHERE case_record.case_id=$1
         GROUP BY case_record.proposed_deduction_amount`,
        [caseId],
      )).rows[0]!;
      const actual=ledger.actual; const proposed=current.proposed_deduction_amount;
      if(input.result!=="full" || !ledger.is_full) {
        fail("实际扣款未达到拟扣金额时必须转财务总监特批",400,"VALIDATION_ERROR");
      }
      const eventId=await this.event(client,actor,"rework.external_deduction.close","external_deduction:close",order); await this.bindAttachments(client,actor,caseId,input.evidenceAttachmentIds);
      await client.query(`INSERT INTO rework_external_deduction_closures(closure_id,case_id,result,proposed_amount,actual_deducted_amount,remaining_amount,reason,evidence_attachment_ids,remaining_difference_disposition,closed_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$4-$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),caseId,input.result,proposed,actual,input.reason??null,input.evidenceAttachmentIds,input.remainingDifferenceDisposition??null,actor.actorId,eventId,actor.requestId]);
      await client.query("UPDATE rework_external_responsibility_cases SET status='closed',case_version=case_version+1 WHERE case_id=$1",[caseId]);
      await this.todos?.completeOpenByDedupePrefix(client,actor,`deduction-overdue:${caseId}:`,"The deduction case was closed");
      return this.getCase(actor,caseId,client);
    });
  }

  requestSpecialApproval(actor: TrustedActorContext, caseId: string, input: RequestExternalDeductionSpecialApproval, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,"rework.external_deduction.special.request",key,{caseId,input},201,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,input.expectedCaseVersion); this.requireStatus(current,["deduction_follow_up"]);
      if(!await this.canPayables(client,actor.actorId,order.rework_order_id,current.responsibility_type)) fail("当前用户无权发起扣款特批",403,"FORBIDDEN");
      await this.readyAttachments(client,input.attachmentIds);
      const ledger=(await client.query<{actual:string;request_version:number}>(
        `SELECT COALESCE(sum(entry.amount),0)::text actual,
                COALESCE((SELECT max(request_version) FROM rework_external_deduction_special_requests WHERE case_id=$1),0)+1 request_version
         FROM rework_external_deduction_entries entry WHERE entry.case_id=$1`,[caseId],
      )).rows[0]!;
      const actual=toCents(ledger.actual); const proposed=toCents(current.proposed_deduction_amount);
      if(actual===proposed) fail("实际扣款已等于拟扣金额，请直接确认完成",400,"VALIDATION_ERROR");
      const eventId=await this.event(client,actor,"rework.external_deduction.special.request","external_deduction:close",order); await this.bindAttachments(client,actor,caseId,input.attachmentIds);
      const requestId=randomUUID();
      await client.query(`INSERT INTO rework_external_deduction_special_requests(special_request_id,case_id,request_version,proposed_amount_snapshot,actual_deducted_amount_snapshot,remaining_amount_snapshot,reason,attachment_ids,requested_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$4-$5,$6,$7,$8,$9,$10)`,[requestId,caseId,ledger.request_version,current.proposed_deduction_amount,ledger.actual,input.reason,input.attachmentIds,actor.actorId,eventId,actor.requestId]);
      await client.query("UPDATE rework_external_responsibility_cases SET status='pending_special_approval',case_version=case_version+1 WHERE case_id=$1",[caseId]);
      await this.todos?.completeOpenByDedupeKey(client,actor,`deduction-follow-up:${caseId}:${current.case_version}`,"Deduction exception was sent to the finance director");
      await this.todos?.completeOpenByDedupePrefix(client,actor,`external-special-return:${caseId}:`,"Returned deduction exception was resubmitted");
      await this.todos?.actionableForUniqueDirectRole(client,actor,{
        category:"external_deduction_special_approval",sourceEventId:eventId,sourceAction:"rework.external_deduction.special.request",
        entityType:"rework_order",entityId:order.rework_order_id,requiredRole:"finance_director",
        requiredCapability:"external_deduction:special_approve",route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},
        policyKey:"finance_return_or_wage_review",dedupeKey:`external-special:${requestId}`,
      });
      return this.getCase(actor,caseId,client);
    });
  }

  approveSpecialApproval(actor: TrustedActorContext, caseId: string, input: ApproveExternalDeductionSpecialApproval, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.decideSpecialApproval(actor,caseId,input.expectedCaseVersion,input.expectedRequestVersion,"approved",input.reason??null,key);
  }

  returnSpecialApproval(actor: TrustedActorContext, caseId: string, input: ReturnExternalDeductionSpecialApproval, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.decideSpecialApproval(actor,caseId,input.expectedCaseVersion,input.expectedRequestVersion,"returned",input.reason,key);
  }

  private decideSpecialApproval(actor: TrustedActorContext, caseId: string, expectedCaseVersion: number, expectedRequestVersion: number, decision: "approved"|"returned", reason: string|null, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,`rework.external_deduction.special.${decision}`,key,{caseId,expectedCaseVersion,expectedRequestVersion,decision,reason},200,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,expectedCaseVersion); this.requireStatus(current,["pending_special_approval"]);
      const permission=await client.query<{permitted:boolean}>("SELECT external_responsibility_direct_role($1,'external_deduction:special_approve',ARRAY['finance_director']) permitted",[actor.actorId]);
      if(!permission.rows[0]?.permitted) fail("当前用户无权审核扣款特批",403,"FORBIDDEN");
      const request=(await client.query<{special_request_id:string;request_version:number;reason:string;attachment_ids:string[];requested_by:string;proposed_amount_snapshot:string;actual_deducted_amount_snapshot:string;remaining_amount_snapshot:string}>(`SELECT special_request_id,request_version,reason,attachment_ids,requested_by,proposed_amount_snapshot::text,actual_deducted_amount_snapshot::text,remaining_amount_snapshot::text FROM rework_external_deduction_special_requests source WHERE case_id=$1 AND NOT EXISTS(SELECT 1 FROM rework_external_deduction_special_decisions decision WHERE decision.special_request_id=source.special_request_id) ORDER BY request_version DESC LIMIT 1 FOR UPDATE`,[caseId])).rows[0]??fail("扣款特批申请不存在",404,"NOT_FOUND");
      if(request.request_version!==expectedRequestVersion) fail("扣款特批申请版本冲突");
      const action=`rework.external_deduction.special.${decision}`; const eventId=await this.event(client,actor,action,"external_deduction:special_approve",order);
      await client.query(`INSERT INTO rework_external_deduction_special_decisions(special_decision_id,special_request_id,decision,reason,decided_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[randomUUID(),request.special_request_id,decision,reason,actor.actorId,eventId,actor.requestId]);
      await this.todos?.completeOpenByDedupeKey(client,actor,`external-special:${request.special_request_id}`,decision==="approved"?"Finance director approved the deduction exception":"Finance director returned the deduction exception");
      if(decision==="approved") {
        const result=toCents(request.actual_deducted_amount_snapshot)===0n?"not_deducted":"partial";
        await client.query(`INSERT INTO rework_external_deduction_closures(closure_id,case_id,result,proposed_amount,actual_deducted_amount,remaining_amount,reason,evidence_attachment_ids,remaining_difference_disposition,closed_by,operation_event_id,request_id,special_request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'财务总监特批确认剩余差额',$9,$10,$11,$12)`,[randomUUID(),caseId,result,request.proposed_amount_snapshot,request.actual_deducted_amount_snapshot,request.remaining_amount_snapshot,request.reason,request.attachment_ids,actor.actorId,eventId,actor.requestId,request.special_request_id]);
        await client.query("UPDATE rework_external_responsibility_cases SET status='closed',case_version=case_version+1 WHERE case_id=$1",[caseId]);
        await this.todos?.completeOpenByDedupePrefix(client,actor,`deduction-overdue:${caseId}:`,"The deduction exception was approved and closed");
      } else {
        await client.query("UPDATE rework_external_responsibility_cases SET status='deduction_follow_up',case_version=case_version+1 WHERE case_id=$1",[caseId]);
        await this.todos?.actionableForUniqueRoleOrOrderDelegate(client,actor,{
          category:"external_deduction_special_return",sourceEventId:eventId,sourceAction:action,
          entityType:"rework_order",entityId:order.rework_order_id,requiredRole:current.payables_handler_role_snapshot,
          requiredCapability:"external_deduction:close",delegationScopeId:order.rework_order_id,
          route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},policyKey:"finance_return_or_wage_review",
          dedupeKey:`external-special-return:${caseId}:${request.special_request_id}`,
        });
      }
      await this.todos?.information(client,actor,{
        category:decision==="approved"?"external_deduction_special_approved":"external_deduction_special_returned",
        sourceEventId:eventId,sourceAction:action,entityType:"rework_order",entityId:order.rework_order_id,
        recipientUserId:request.requested_by,route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},
        dedupeKey:`external-special-decision:${request.special_request_id}:${decision}`,
      });
      return this.getCase(actor,caseId,client);
    });
  }

  requestRevision(actor: TrustedActorContext, caseId: string, input: CreateExternalResponsibilityRevision, key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,"rework.external_responsibility.revision.request",key,{caseId,input},201,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,input.expectedCaseVersion); this.requireStatus(current,["pending_business_signoff","returned","pending_payables_confirmation","deduction_follow_up","closed"]);
      if(!await this.canSign(client,actor.actorId,order.rework_order_id,current.responsibility_type)) fail("当前用户无权申请责任变更",403,"FORBIDDEN"); await this.readyAttachments(client,input.attachmentIds);
      if(current.status==="closed") { const closure=await client.query<{result:"full"|"partial"|"not_deducted";remaining_amount:string}>("SELECT result,remaining_amount::text FROM rework_external_deduction_closures WHERE case_id=$1",[caseId]); const closed=closure.rows[0]; if(!closed || closed.result==="full" || toCents(closed.remaining_amount)<=0n) fail("仅存在未扣差额的已关闭台账可以申请责任变更",409,"INVALID_STATE_TRANSITION"); }
      const finalized=await client.query<{finalized_determination_id:string;finalized_determination_version:number}>("SELECT finalized_determination_id,finalized_determination_version FROM rework_external_responsibility_batches WHERE batch_id=$1",[current.batch_id]); const source=finalized.rows[0]??fail("外部责任批次不存在");
      const eventId=await this.event(client,actor,"rework.external_responsibility.revision.request","external_responsibility:request_revision",order); await this.bindAttachments(client,actor,caseId,input.attachmentIds);
      await client.query(`INSERT INTO rework_external_responsibility_revision_requests(revision_request_id,case_id,source_case_status,finalized_determination_id,finalized_determination_version,requested_change,reason,attachment_ids,requested_by,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[randomUUID(),caseId,current.status,source.finalized_determination_id,source.finalized_determination_version,input.requestedChange,input.reason,input.attachmentIds,actor.actorId,eventId,actor.requestId]);
      await client.query("UPDATE rework_external_responsibility_cases SET status='pending_responsibility_revision',case_version=case_version+1 WHERE case_id=$1",[caseId]);
      return this.getCase(actor,caseId,client);
    });
  }

  decideRevision(actor: TrustedActorContext, requestId: string, input: DecideExternalResponsibilityRevision, decision: "approved" | "rejected", key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,`rework.external_responsibility.revision.${decision}`,key,{requestId,input,decision},200,async(client)=>{
      const revision=await client.query<{revision_request_id:string;case_id:string;source_case_status:"pending_business_signoff"|"returned"|"pending_payables_confirmation"|"deduction_follow_up"|"closed";revision_version:number;status:"pending"|"approved"|"rejected"}>("SELECT revision_request_id,case_id,source_case_status,revision_version,status FROM rework_external_responsibility_revision_requests WHERE revision_request_id=$1 FOR UPDATE",[requestId]); const currentRevision=revision.rows[0]??fail("责任变更申请不存在",404,"NOT_FOUND");
      const current=await this.lockCase(client,currentRevision.case_id); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,input.expectedCaseVersion); if(currentRevision.revision_version!==input.expectedRevisionVersion || currentRevision.status!=="pending") fail("责任变更申请已经处理");
      const canApprove=await client.query<{permitted:boolean}>("SELECT external_responsibility_direct_role($1,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']) permitted",[actor.actorId]); if(!canApprove.rows[0]?.permitted) fail("当前用户无权审核责任变更",403,"FORBIDDEN");
      const action=decision==="approved"?"rework.external_responsibility.revision.approve":"rework.external_responsibility.revision.reject"; const eventId=await this.event(client,actor,action,"external_responsibility:approve_revision",order,decision==="approved"?"pending_responsibility_determination":order.status,decision==="approved"?order.version+1:order.version);
      await client.query("UPDATE rework_external_responsibility_revision_requests SET status=$2,revision_version=revision_version+1,decided_by=$3,decision_reason=$4,decision_operation_event_id=$5,decision_request_id=$6,decided_at=CURRENT_TIMESTAMP WHERE revision_request_id=$1",[requestId,decision,actor.actorId,input.reason??null,eventId,actor.requestId]);
      if(decision==="approved") { await client.query("UPDATE rework_external_responsibility_cases SET status='superseded',case_version=case_version+1 WHERE batch_id=$1 AND status<>'closed'",[current.batch_id]); await client.query("UPDATE rework_external_responsibility_batches SET status='superseded',batch_version=batch_version+1 WHERE batch_id=$1",[current.batch_id]); await client.query("UPDATE rework_orders SET status='pending_responsibility_determination',version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",[order.rework_order_id,actor.actorId]); } else { await client.query("UPDATE rework_external_responsibility_cases SET status=$2,case_version=case_version+1 WHERE case_id=$1",[current.case_id,currentRevision.source_case_status]); }
      return this.getCase(actor,current.case_id,client);
    });
  }

  private async payablesDecision(actor: TrustedActorContext, caseId: string, expectedCaseVersion: number, decision: "accepted" | "returned", reason: string | null, attachmentIds: string[], key: string): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.mutate(actor,`rework.external_responsibility.payables_${decision === "accepted" ? "accept" : "return"}`,key,{caseId,expectedCaseVersion,decision,reason,attachmentIds},200,async(client)=>{
      const current=await this.lockCase(client,caseId); const order=await this.order(client,current.rework_order_id,true); this.requireCaseVersion(current,expectedCaseVersion); this.requireStatus(current,["pending_payables_confirmation"]);
      if(!await this.canPayables(client,actor.actorId,order.rework_order_id,current.responsibility_type)) fail("当前用户无权确认该应付台账",403,"FORBIDDEN"); await this.readyAttachments(client,attachmentIds);
      const eventAction=decision==="accepted"?"rework.external_responsibility.payables_accept":"rework.external_responsibility.payables_return"; const eventId=await this.event(client,actor,eventAction,"external_responsibility:payables_confirm",order); await this.bindAttachments(client,actor,caseId,attachmentIds);
      await client.query(`INSERT INTO rework_external_payables_actions(payables_action_id,case_id,action,acted_by,actor_role_snapshot,reason,attachment_ids,operation_event_id,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[randomUUID(),caseId,decision,actor.actorId,this.roles(actor),reason,attachmentIds,eventId,actor.requestId]);
      const next=decision==="accepted"?"deduction_follow_up":"returned"; await client.query("UPDATE rework_external_responsibility_cases SET status=$2,case_version=case_version+1,payables_confirmed_at=CASE WHEN $2='deduction_follow_up' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE case_id=$1",[caseId,next]);
      await this.todos?.completeOpenByDedupeKey(client,actor,`external-payables:${caseId}:${current.case_version}`,decision==="accepted"?"External payables confirmation accepted":"External payables confirmation returned");
      if(decision==="accepted") {
        await maybeCompleteResponsibilityAction(client,actor,order);
        await this.outbox.enqueue(client,{topic:"rework.external_responsibility.deduction_follow_up",aggregateType:"external_responsibility_case",aggregateId:caseId,recipientKey:actor.actorId,idempotencyKey:`external-case:follow-up:${caseId}`,payload:{caseId,reworkOrderId:order.rework_order_id,delivery:"intent_only"}});
        await this.todos?.actionableForUniqueRoleOrOrderDelegate(client,actor,{
          category:"external_deduction_follow_up",sourceEventId:eventId,sourceAction:"rework.external_responsibility.payables_accept",
          entityType:"rework_order",entityId:order.rework_order_id,requiredRole:current.payables_handler_role_snapshot,
          requiredCapability:"external_deduction:follow_up",delegationScopeId:order.rework_order_id,
          route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},policyKey:"general",
          dedupeKey:`deduction-follow-up:${caseId}:${current.case_version+1}`,
        });
        await this.todos?.information(client,actor,{
          category:"external_payables_accepted",sourceEventId:eventId,sourceAction:"rework.external_responsibility.payables_accept",
          entityType:"rework_order",entityId:order.rework_order_id,recipientUserId:current.business_handler_user_id,
          route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},
          dedupeKey:`external-payables-accepted:${caseId}:${current.case_version+1}:${current.business_handler_user_id}`,
        });
      } else {
        const sourceSignoff=await client.query<{operation_event_id:string}>("SELECT operation_event_id FROM rework_external_business_signoffs WHERE case_id=$1 ORDER BY created_at DESC,signoff_id DESC LIMIT 1 FOR KEY SHARE",[caseId]);
        const sourceSignoffEventId=sourceSignoff.rows[0]?.operation_event_id??fail("外部业务签收原始事件不存在，不能创建可追溯的退回待办",409,"CONFLICT");
        await this.todos?.actionableForNamedSourceActor(client,actor,{
          category:"external_payables_return",sourceEventId:eventId,sourceAction:"rework.external_responsibility.payables_return",
          entityType:"rework_order",entityId:order.rework_order_id,recipientUserId:current.business_handler_user_id,
          sourceActorEventId:sourceSignoffEventId,permittedCapabilities:["external_responsibility:sign"],
          route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},policyKey:"finance_return_or_wage_review",
          dedupeKey:`external-return:${caseId}:${current.case_version+1}`,
        });
        await this.todos?.information(client,actor,{
          category:"external_payables_returned",sourceEventId:eventId,sourceAction:"rework.external_responsibility.payables_return",
          entityType:"rework_order",entityId:order.rework_order_id,recipientUserId:actor.actorId,
          route:{routeName:"external_responsibility_detail",entityId:caseId,reworkOrderId:order.rework_order_id},
          dedupeKey:`external-returned:${caseId}:${current.case_version+1}:${actor.actorId}`,
        });
      }
      return this.getCase(actor,caseId,client);
    });
  }

  private async caseDto(actor: TrustedActorContext, row: CaseRow, executor: Queryable): Promise<ExternalResponsibilityCaseResponse> {
    const [items,deductions,followUps,closure,special,revisions,permissions] = await Promise.all([
      executor.query<{external_item_id:string;configuration_item_id:string;responsibility_type:ResponsibilityType;process_snapshot:Record<string,unknown>;multiplier_snapshot:string;share_bps_snapshot:number;proposed_amount:string;amount_line_snapshot:Record<string,unknown>}>(`SELECT item.external_item_id,item.configuration_item_id,item.responsibility_type,item.process_snapshot,item.multiplier_snapshot::text,item.share_bps_snapshot,item.proposed_amount::text,item.amount_line_snapshot FROM rework_external_responsibility_case_items mapping JOIN rework_external_responsibility_items item ON item.external_item_id=mapping.external_item_id WHERE mapping.case_id=$1 ORDER BY item.configuration_item_id`,[row.case_id]),
      executor.query<{deduction_entry_id:string;entry_type:"deduction"|"adjustment"|"reversal";amount:string;deducted_on:string;reference_no:string|null;attachment_ids:string[];reverses_entry_id:string|null;recorded_by:string;created_at:Date}>(`SELECT deduction_entry_id,entry_type,amount::text,deducted_on::text,reference_no,attachment_ids,reverses_entry_id,recorded_by,created_at FROM rework_external_deduction_entries WHERE case_id=$1 ORDER BY created_at,deduction_entry_id`,[row.case_id]),
      executor.query<{follow_up_id:string;content:string;supplier_feedback:string|null;next_follow_up_at:Date|null;attachment_ids:string[];created_by:string;created_at:Date}>(`SELECT follow_up_id,content,supplier_feedback,next_follow_up_at,attachment_ids,created_by,created_at FROM rework_external_deduction_follow_ups WHERE case_id=$1 ORDER BY created_at,follow_up_id`,[row.case_id]),
      executor.query<{result:"full"|"partial"|"not_deducted";proposed_amount:string;actual_deducted_amount:string;remaining_amount:string;reason:string|null;evidence_attachment_ids:string[];remaining_difference_disposition:string|null;closed_by:string;closed_at:Date}>(`SELECT result,proposed_amount::text,actual_deducted_amount::text,remaining_amount::text,reason,evidence_attachment_ids,remaining_difference_disposition,closed_by,closed_at FROM rework_external_deduction_closures WHERE case_id=$1`,[row.case_id]),
      executor.query<{special_request_id:string;request_version:number;reason:string;attachment_ids:string[];proposed_amount_snapshot:string;actual_deducted_amount_snapshot:string;remaining_amount_snapshot:string;requested_by:string;requested_at:Date;decision:"approved"|"returned"|null;decision_reason:string|null;decided_by:string|null;decided_at:Date|null}>(`SELECT source.special_request_id,source.request_version,source.reason,source.attachment_ids,source.proposed_amount_snapshot::text,source.actual_deducted_amount_snapshot::text,source.remaining_amount_snapshot::text,source.requested_by,source.requested_at,decision.decision,decision.reason decision_reason,decision.decided_by,decision.decided_at FROM rework_external_deduction_special_requests source LEFT JOIN rework_external_deduction_special_decisions decision USING(special_request_id) WHERE source.case_id=$1 ORDER BY source.request_version DESC LIMIT 1`,[row.case_id]),
      executor.query<{revision_request_id:string;revision_version:number;status:"pending"|"approved"|"rejected";reason:string;requested_change:Record<string,unknown>;requested_by:string;decided_by:string|null;decision_reason:string|null;created_at:Date;decided_at:Date|null}>(`SELECT revision_request_id,revision_version,status,reason,requested_change,requested_by,decided_by,decision_reason,created_at,decided_at FROM rework_external_responsibility_revision_requests WHERE case_id=$1 ORDER BY created_at`,[row.case_id]),
      executor.query<{can_sign:boolean;can_payables:boolean;can_approve_revision:boolean;can_special_approve:boolean}>(`SELECT external_responsibility_can_sign($1,$2,$3) can_sign,external_responsibility_can_payables($1,$2,$3) can_payables,external_responsibility_direct_role($1,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']) can_approve_revision,external_responsibility_direct_role($1,'external_deduction:special_approve',ARRAY['finance_director']) can_special_approve`,[actor.actorId,row.rework_order_id,row.responsibility_type]),
    ]);
    const actual=deductions.rows.reduce((sum,rowValue)=>sum+toCents(rowValue.amount),0n); const proposed=toCents(row.proposed_deduction_amount);
    const permitted=permissions.rows[0] ?? {can_sign:false,can_payables:false,can_approve_revision:false,can_special_approve:false}; const closed=row.status==="closed"; const active=row.batch_status==="active"; const unresolvedClosedDifference=closed&&actual>0n&&actual<proposed || closed&&actual===0n&&proposed>0n; const latestSpecial=special.rows[0];
    return { caseId:row.case_id,batchId:row.batch_id,reworkOrderId:row.rework_order_id,responsibilityType:row.responsibility_type,supplier:{supplierId:row.supplier_id,version:row.supplier_version,code:row.supplier_code_snapshot,name:row.supplier_name_snapshot,type:row.supplier_type_snapshot},businessHandlerUserId:row.business_handler_user_id,payablesHandlerRole:row.payables_handler_role_snapshot,proposedDeductionAmount:row.proposed_deduction_amount,actualDeductedAmount:money(actual),remainingAmount:money(proposed-actual),caseVersion:row.case_version,status:row.status,submittedAt:toIso(row.submitted_at),payablesConfirmedAt:toIso(row.payables_confirmed_at),canSign:active&&permitted.can_sign && ["pending_business_signoff","returned"].includes(row.status),canPayablesConfirm:active&&permitted.can_payables && row.status==="pending_payables_confirmation",canFollowUp:active&&!closed && (permitted.can_sign||permitted.can_payables) && row.status==="deduction_follow_up",canRecordDeduction:active&&!closed&&permitted.can_payables&&row.status==="deduction_follow_up",canClose:active&&!closed&&permitted.can_payables&&row.status==="deduction_follow_up"&&actual===proposed,canRequestSpecialApproval:active&&!closed&&permitted.can_payables&&row.status==="deduction_follow_up"&&actual!==proposed,canDecideSpecialApproval:active&&!closed&&permitted.can_special_approve&&row.status==="pending_special_approval",canRequestRevision:active&&permitted.can_sign&&(["pending_business_signoff","returned","pending_payables_confirmation","deduction_follow_up"].includes(row.status)||unresolvedClosedDifference),canApproveRevision:active&&permitted.can_approve_revision&&row.status==="pending_responsibility_revision",items:items.rows.map((item)=>this.itemDto(item)),deductions:deductions.rows.map((entry)=>({deductionEntryId:entry.deduction_entry_id,entryType:entry.entry_type,amount:entry.amount,deductedOn:entry.deducted_on,referenceNo:entry.reference_no,attachmentIds:entry.attachment_ids,reversesEntryId:entry.reverses_entry_id,recordedBy:entry.recorded_by,createdAt:entry.created_at.toISOString()})),followUps:followUps.rows.map((follow)=>({followUpId:follow.follow_up_id,content:follow.content,supplierFeedback:follow.supplier_feedback,nextFollowUpAt:toIso(follow.next_follow_up_at),attachmentIds:follow.attachment_ids,createdBy:follow.created_by,createdAt:follow.created_at.toISOString()})),closure:closure.rows[0]?{result:closure.rows[0].result,proposedAmount:closure.rows[0].proposed_amount,actualDeductedAmount:closure.rows[0].actual_deducted_amount,remainingAmount:closure.rows[0].remaining_amount,reason:closure.rows[0].reason,evidenceAttachmentIds:closure.rows[0].evidence_attachment_ids,remainingDifferenceDisposition:closure.rows[0].remaining_difference_disposition,closedBy:closure.rows[0].closed_by,closedAt:closure.rows[0].closed_at.toISOString()}:null,specialApproval:latestSpecial?{requestId:latestSpecial.special_request_id,requestVersion:latestSpecial.request_version,reason:latestSpecial.reason,attachmentIds:latestSpecial.attachment_ids,proposedAmount:latestSpecial.proposed_amount_snapshot,actualDeductedAmount:latestSpecial.actual_deducted_amount_snapshot,remainingAmount:latestSpecial.remaining_amount_snapshot,requestedBy:latestSpecial.requested_by,requestedAt:latestSpecial.requested_at.toISOString(),decision:latestSpecial.decision&&latestSpecial.decided_by&&latestSpecial.decided_at?{decision:latestSpecial.decision,reason:latestSpecial.decision_reason,decidedBy:latestSpecial.decided_by,decidedAt:latestSpecial.decided_at.toISOString()}:null}:null,revisionRequests:revisions.rows.map((request)=>({revisionRequestId:request.revision_request_id,revisionVersion:request.revision_version,status:request.status,reason:request.reason,requestedChange:request.requested_change,requestedBy:request.requested_by,decidedBy:request.decided_by,decisionReason:request.decision_reason,createdAt:request.created_at.toISOString(),decidedAt:toIso(request.decided_at)})) };
  }
  private itemDto(item:{external_item_id:string;configuration_item_id:string;responsibility_type:ResponsibilityType;process_snapshot:Record<string,unknown>;multiplier_snapshot:string;share_bps_snapshot:number;proposed_amount:string;amount_line_snapshot:Record<string,unknown>}) { return {externalItemId:item.external_item_id,configurationItemId:item.configuration_item_id,responsibilityType:item.responsibility_type,processSnapshot:item.process_snapshot,multiplierSnapshot:item.multiplier_snapshot,shareBpsSnapshot:item.share_bps_snapshot,proposedAmount:item.proposed_amount,amountLineSnapshot:item.amount_line_snapshot}; }
  private async order(client:Queryable,orderId:string,locked:boolean):Promise<OrderRow>{const result=await client.query<OrderRow>(`SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,problem_part,problem_description,rework_quantity FROM rework_orders WHERE rework_order_id=$1 ${locked?"FOR UPDATE":""}`,[orderId]);return result.rows[0]??fail("返工单不存在",404,"NOT_FOUND");}
  private async lockCase(client:PoolClient,caseId:string):Promise<CaseRow>{const result=await client.query<CaseRow>(`SELECT target_case.case_id,target_case.batch_id,target_case.rework_order_id,target_case.responsibility_type,target_case.supplier_id,target_case.supplier_version,target_case.supplier_code_snapshot,target_case.supplier_name_snapshot,target_case.supplier_type_snapshot,target_case.business_handler_user_id,target_case.payables_handler_role_snapshot,target_case.proposed_deduction_amount::text,target_case.case_version,target_case.status,batch.status batch_status,target_case.submitted_at,target_case.payables_confirmed_at FROM rework_external_responsibility_cases target_case JOIN rework_external_responsibility_batches batch USING(batch_id) WHERE target_case.case_id=$1 FOR UPDATE OF target_case,batch`,[caseId]);const current=result.rows[0]??fail("外部责任台账不存在",404,"NOT_FOUND");if(current.batch_status!=="active")fail("责任版本已被替代，不能继续处理历史案件",409,"INVALID_STATE_TRANSITION");return current;}
  private requireCaseVersion(current:CaseRow,expected:number){if(current.case_version!==expected)fail("外部责任台账版本冲突");}
  private requireStatus(current:CaseRow,expected:CaseStatus[]){if(!expected.includes(current.status))fail("外部责任台账当前状态不允许该操作",409,"INVALID_STATE_TRANSITION");}
  private roles(actor:TrustedActorContext){return [...new Set(actor.actorRoles)].sort();}
  private async canSign(client:Queryable,actorId:string,orderId:string,type:ResponsibilityType){const result=await client.query<{permitted:boolean}>("SELECT external_responsibility_can_sign($1,$2,$3) permitted",[actorId,orderId,type]);return result.rows[0]?.permitted===true;}
  private async canPayables(client:Queryable,actorId:string,orderId:string,type:ResponsibilityType){const result=await client.query<{permitted:boolean}>("SELECT external_responsibility_can_payables($1,$2,$3) permitted",[actorId,orderId,type]);return result.rows[0]?.permitted===true;}
  private async readyAttachments(client:Queryable,attachmentIds:readonly string[]){if(!attachmentIds.length)return; if(new Set(attachmentIds).size!==attachmentIds.length)fail("附件不能重复",400,"VALIDATION_ERROR"); const result=await client.query<{attachment_id:string}>("SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND status='ready'",[attachmentIds]);if(result.rowCount!==attachmentIds.length)fail("附件必须已完成并处于 ready 状态",409,"ATTACHMENT_NOT_READY");}
  private async bindAttachments(client:PoolClient,actor:TrustedActorContext,caseId:string,attachmentIds:readonly string[]){if(!attachmentIds.length)return; const candidates=await client.query<{attachment_id:string}>(`SELECT attachment_id FROM attachments WHERE attachment_id=ANY($1::uuid[]) AND uploaded_by=$2 AND status='ready' AND ((entity_type IS NULL AND entity_id IS NULL) OR (entity_type='external_responsibility_case' AND entity_id=$3)) FOR UPDATE`,[attachmentIds,actor.actorId,caseId]);if(candidates.rowCount!==attachmentIds.length)fail("附件未完成、并非本人上传或已绑定其他业务",409,"ATTACHMENT_NOT_READY");await client.query("UPDATE attachments SET entity_type='external_responsibility_case',entity_id=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=ANY($1::uuid[]) AND entity_type IS NULL AND entity_id IS NULL",[attachmentIds,caseId]);}
  private async event(client:PoolClient,actor:TrustedActorContext,action:string,capability:string,order:OrderRow,nextStatus=order.status,nextVersion=order.version):Promise<string>{const eventId=await this.events.append(client,{...actor,authorizationCapability:capability},{action,entityType:"rework_order",entityId:order.rework_order_id,before:orderAudit(order),after:orderAudit(order,nextStatus,nextVersion)});await client.query("SELECT set_config('dx_rework.external_responsibility_event_id',$1,true),set_config('dx_rework.external_responsibility_request_id',$2,true)",[eventId,actor.requestId]);if(nextStatus!==order.status){await client.query("SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",[eventId,actor.requestId]);}return eventId;}
  private async mutate<T>(actor:TrustedActorContext,scope:string,key:string,payload:unknown,statusCode:number,work:(client:PoolClient)=>Promise<T>):Promise<Result<T>>{const client=await this.database.connect();try{await client.query("BEGIN");const result=await this.idempotency.execute(client,{scope,actorKey:actor.actorId,key,requestHash:createHash("sha256").update(JSON.stringify(payload)).digest("hex"),expiresAt:new Date(Date.now()+30*24*60*60*1000)},async()=>({statusCode,response:await work(client)}));await client.query("COMMIT");return{value:result.response,reused:result.reused};}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}}
}
