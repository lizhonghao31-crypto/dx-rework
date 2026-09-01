import { createHash, randomUUID } from "node:crypto";

import type {
  ConfirmQuantityIncrease,
  CorrectWorkReportQuantities,
  CorrectWorkReportQuantity,
  CreateQuantityDecrease,
  CreateQuantityIncrease,
  QuantityAdjustmentResponse,
  RejectWorkReport,
  ReviewFinalQuantity,
  ReviewQuantityIncrease,
  ReviewWholeOrder,
  WholeOrderReviewResponse,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type OrderRow = Readonly<{
  rework_order_id: string; rework_no: string | null; status: string; version: number;
  style_no: string | null; order_no: string | null; merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null; processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null; problem_part: string | null;
  problem_description: string | null; rework_quantity: number | null; tail_inspection_required: boolean;
}>;
type PlanRow = Readonly<{
  configuration_item_id: string; process_name: string; pricing_unit: "piece" | "hour";
  planned_quantity: string; original_completed_quantity: string; completed_quantity: string;
  original_tail_checked_quantity: string; tail_checked_quantity: string; unit_price: string | null;
}>;
type TemporaryWorkerRow = Readonly<{
  configuration_item_id: string; process_name: string; person_id: string; display_name: string;
  multiplier: string | null; reason: string | null;
}>;
type ReportRow = Readonly<{
  work_report_id: string; work_task_id: string; configuration_item_id: string; actual_quantity: string;
  completed_at: Date; submitted_by: string; resubmits_work_report_id: string | null;
  assignment_mode: "individual" | "collective"; execution_kind: "worker" | "tail_inspection"; report_rejection_id: string | null;
  rejected_person_id: string | null; rejection_reason: string | null;
  effective_quantity: string; correction_version: number | null; corrected_by: string | null; corrected_at: Date | null;
}>;
type MemberRow = Readonly<{ work_report_id: string; person_id: string; display_name: string }>;
type AdjustmentRow = Readonly<{
  adjustment_id: string; configuration_item_id: string; adjustment_version: number;
  adjustment_kind: "decrease" | "increase";
  status: "effective" | "pending_merchandiser_confirmation" | "pending_ie_review" | "rejected" | "expired";
  previous_planned_quantity: string; requested_planned_quantity: string; reason: string;
  requires_ie_review: boolean; expires_at: Date | null; requested_by: string; requested_at: Date;
  confirmed_by: string | null; confirmed_at: Date | null; reviewed_by: string | null; reviewed_at: Date | null;
}>;
type AdjustmentForUpdate = AdjustmentRow & Readonly<{
  rework_order_id: string; confirmation_reason: string | null;
}>;
type ItemRow = Readonly<{ configuration_item_id: string; execution_kind: "worker" | "tail_inspection"; pricing_unit: "piece" | "hour"; planned_quantity: string }>;
type FinalConfirmationRow = Readonly<{
  confirmation_id: string; confirmation_version: number; confirmed_by: string; confirmed_at: Date;
  workflow_stage: "approved" | "pending_ie_review"; price_snapshot_required: boolean;
  decision: "approved" | "rejected" | null;
  reviewed_by: string | null; reviewed_at: Date | null; review_reason: string | null;
}>;
type FinalQuantityRow = Readonly<{
  configuration_item_id: string; worker_reported_quantity: string;
  tail_reported_quantity: string; final_confirmed_quantity: string;
}>;
type FinalPriceRow = Readonly<{
  configuration_item_id: string; original_unit_price: string; proposed_unit_price: string;
}>;

const numberValue = (value: string | number): number => Number(value);
const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");
const error = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const iso = (value: Date | null): string | null => value?.toISOString() ?? null;

export class WholeOrderReviewService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async get(actor: TrustedActorContext, reworkOrderId: string, configurationItemId?: string): Promise<WholeOrderReviewResponse> {
    const order = await this.order(this.database, reworkOrderId, false);
    if (configurationItemId) {
      const scopedItem = await this.database.query(
        `SELECT 1 FROM rework_process_configurations configuration
         JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
         WHERE configuration.rework_order_id=$1 AND configuration.status='approved' AND item.configuration_item_id=$2`,
        [reworkOrderId, configurationItemId],
      );
      if (!scopedItem.rowCount) error("工序不存在或不属于该返工单当前生效配置", 404, "NOT_FOUND");
    }
    const ieStage = order.status === "pending_final_quantity_ie_review";
    const canReview = await this.can(actor, "tail_supervisor", "submission:audit", order, configurationItemId);
    const canIeReview = await this.can(actor, "ie_reviewer", "process:review", order, configurationItemId);
    if (!(ieStage ? canIeReview : canReview)) error("当前用户无权读取最终数量确认信息", 403, "FORBIDDEN");
    return this.dto(this.database, order, {
      canReview, canIeReview, canAdjustQuantity: false, canConfirmQuantity: false, canReviewQuantityIncrease: false,
    }, configurationItemId);
  }

  async approve(actor: TrustedActorContext, reworkOrderId: string, input: ReviewWholeOrder, key: string): Promise<Result<WholeOrderReviewResponse>> {
    if (!await this.finalQuantityReviewAvailable(this.database)) return this.approveLegacy(actor, reworkOrderId, input, key);
    return this.mutate(actor, "rework.tail_completion.confirm", key, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      await this.ensureOrderWide(actor, "tail_supervisor", "submission:audit", order);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") error("当前返工单尚未进入 N05 尾部最终数量确认节点", 409, "INVALID_STATE_TRANSITION");
      const plans = await this.plans(client, reworkOrderId);
      if (plans.length === 0 || plans.some((plan) => plan.unit_price === null)) {
        error("每道工序必须完成 IE 核价后才能确认最终数量", 409, "INVALID_STATE_TRANSITION");
      }
      const submittedPrices = input.processPrices ?? plans.map((plan) => ({
        configurationItemId: plan.configuration_item_id,
        unitPrice: numberValue(plan.unit_price!),
      }));
      const submittedPriceIds = new Set(submittedPrices.map((price) => price.configurationItemId));
      const expectedPriceIds = new Set(plans.map((plan) => plan.configuration_item_id));
      if (submittedPriceIds.size !== expectedPriceIds.size
        || [...expectedPriceIds].some((value) => !submittedPriceIds.has(value))) {
        error("最终价格必须完整覆盖当前生效的每道工序", 400, "VALIDATION_ERROR");
      }
      const finalPrices = plans.map((plan) => ({
        configurationItemId: plan.configuration_item_id,
        originalUnitPrice: numberValue(plan.unit_price!),
        proposedUnitPrice: submittedPrices.find((price) => price.configurationItemId === plan.configuration_item_id)!.unitPrice,
      }));
      await this.assertTailReconciliation(client, reworkOrderId, order.tail_inspection_required);
      const finalQuantities = plans.map((plan) => ({
        configurationItemId: plan.configuration_item_id,
        finalConfirmedQuantity: numberValue(plan.completed_quantity),
      }));
      const temporaryWorkers = await this.temporaryWorkers(client, reworkOrderId);
      const submittedCoefficientKeys = new Set(input.temporaryCoefficients.map((item) => `${item.configurationItemId}:${item.personId}`));
      const expectedCoefficientKeys = new Set(temporaryWorkers.map((worker) => `${worker.configuration_item_id}:${worker.person_id}`));
      if (submittedCoefficientKeys.size !== expectedCoefficientKeys.size
        || [...expectedCoefficientKeys].some((value) => !submittedCoefficientKeys.has(value))) {
        error("每名临时工每道工序都必须保留一个实发系数；默认填 1.0", 400, "VALIDATION_ERROR");
      }
      const active = await client.query(
        `SELECT 1 FROM rework_tail_completion_confirmations confirmation
         WHERE confirmation.rework_order_id=$1 AND confirmation.workflow_stage='pending_ie_review'
           AND NOT EXISTS(SELECT 1 FROM rework_tail_completion_reviews review WHERE review.confirmation_id=confirmation.confirmation_id)
         LIMIT 1 FOR SHARE`,
        [reworkOrderId],
      );
      if (active.rowCount) error("本单已有一版最终数量等待 IE 复核", 409, "CONFLICT");
      const version = await client.query<{ next_version: number }>(
        "SELECT COALESCE(max(confirmation_version),0)::int+1 AS next_version FROM rework_tail_completion_confirmations WHERE rework_order_id=$1",
        [reworkOrderId],
      );
      const confirmationVersion = version.rows[0]?.next_version ?? 1;
      const confirmationId = randomUUID();
      const eventId = await this.events.append(client, this.withCapability(actor, "submission:audit"), {
        action: "rework.tail_completion.confirm", entityType: "rework_order", entityId: reworkOrderId,
        before: this.orderAudit(order),
        after: {
          ...this.orderAudit(order, "pending_final_quantity_ie_review", order.version + 1),
          confirmationId, confirmationVersion, finalQuantities, finalPrices,
          temporaryCoefficients: input.temporaryCoefficients,
        },
      });
      await this.context(client, eventId, actor.requestId, "whole_order_review");
      await client.query(
        `INSERT INTO rework_tail_completion_confirmations(
           confirmation_id,rework_order_id,confirmation_version,workflow_stage,price_snapshot_required,
           confirmed_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,'pending_ie_review',true,$4,$5,$6)`,
        [confirmationId, reworkOrderId, confirmationVersion, actor.actorId, eventId, actor.requestId],
      );
      for (const price of finalPrices) {
        await client.query(
          `INSERT INTO rework_tail_completion_prices(
             confirmation_id,configuration_item_id,original_unit_price,proposed_unit_price
           ) VALUES($1,$2,$3,$4)`,
          [confirmationId, price.configurationItemId, price.originalUnitPrice, price.proposedUnitPrice],
        );
      }
      for (const quantity of finalQuantities) {
        const plan = plans.find((candidate) => candidate.configuration_item_id === quantity.configurationItemId)!;
        await client.query(
          `INSERT INTO rework_tail_completion_quantities(
             confirmation_id,configuration_item_id,worker_reported_quantity,tail_reported_quantity,final_confirmed_quantity
           ) VALUES($1,$2,$3,$4,$5)`,
          [confirmationId, quantity.configurationItemId, numberValue(plan.completed_quantity), numberValue(plan.tail_checked_quantity), quantity.finalConfirmedQuantity],
        );
      }
      for (const coefficient of input.temporaryCoefficients) {
        await client.query(
          `INSERT INTO rework_tail_completion_coefficients(
             confirmation_id,configuration_item_id,person_id,multiplier,reason
           ) VALUES($1,$2,$3,$4,$5)`,
          [confirmationId, coefficient.configurationItemId, coefficient.personId, coefficient.multiplier, coefficient.reason ?? null],
        );
      }
      await client.query(
        "UPDATE rework_orders SET status='pending_final_quantity_ie_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId],
      );
      await this.todos?.completeOpenByDedupePrefix(client, actor, `whole-order-review:${reworkOrderId}:`, "Final quantities were submitted");
      await this.todos?.actionableForUniqueDirectRole(client, actor, {
        category: "final_quantity_ie_review",
        sourceEventId: eventId,
        sourceAction: "rework.tail_completion.confirm",
        entityType: "rework_order",
        entityId: reworkOrderId,
        requiredRole: "ie_reviewer",
        requiredCapability: "process:review",
        route: { routeName: "rework_detail", entityId: reworkOrderId, tab: "final_quantity_ie_review" },
        policyKey: "general",
        dedupeKey: `final-quantity-ie-review:${reworkOrderId}:${confirmationVersion}`,
      });
      await this.outbox.enqueue(client, {
        topic: "rework.final_quantity.pending_ie_review", aggregateType: "rework_order", aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: order.rework_no, confirmationId, confirmationVersion },
        recipientKey: "role:ie_reviewer", idempotencyKey: `${reworkOrderId}:final-quantity:${confirmationId}`,
      });
      return this.dto(client, await this.order(client, reworkOrderId, false), await this.permissions(client, actor, order));
    });
  }

  async reviewFinalQuantity(actor: TrustedActorContext, reworkOrderId: string, input: ReviewFinalQuantity, key: string): Promise<Result<WholeOrderReviewResponse>> {
    return this.mutate(actor, "rework.final_quantity.ie_review", key, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      await this.ensureOrderWide(actor, "ie_reviewer", "process:review", order);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_final_quantity_ie_review") error("当前返工单不在 N06 IE 最终数量复核节点", 409, "INVALID_STATE_TRANSITION");
      const confirmation = await this.currentConfirmation(client, reworkOrderId, true);
      const pendingConfirmation = confirmation ?? error("没有等待 IE 复核的最终数量确认版本", 409, "CONFLICT");
      if (pendingConfirmation.decision !== null) error("该最终数量确认版本已经完成 IE 复核", 409, "CONFLICT");
      const finalPrices = await this.confirmationPrices(client, pendingConfirmation.confirmation_id);
      if (pendingConfirmation.price_snapshot_required && finalPrices.length === 0) {
        error("最终价格快照不完整，不能进行 IE 复核", 409, "CONFLICT");
      }
      const approved = input.decision === "approved";
      const nextStatus = approved ? "pending_responsibility_determination" : "pending_order_review";
      const reviewId = randomUUID();
      const orderReviewId = approved ? randomUUID() : null;
      const eventId = await this.events.append(client, this.withCapability(actor, "process:review"), {
        action: "rework.final_quantity.ie_review", entityType: "rework_order", entityId: reworkOrderId,
        before: { ...this.orderAudit(order), confirmationId: pendingConfirmation.confirmation_id, confirmationVersion: pendingConfirmation.confirmation_version },
        after: {
          ...this.orderAudit(order, nextStatus, order.version + 1),
          confirmationId: pendingConfirmation.confirmation_id, confirmationVersion: pendingConfirmation.confirmation_version,
          decision: input.decision, orderReviewId,
          finalPrices: finalPrices.map((price) => ({
            configurationItemId: price.configuration_item_id,
            originalUnitPrice: numberValue(price.original_unit_price),
            proposedUnitPrice: numberValue(price.proposed_unit_price),
          })),
        },
        ...(input.reason ? { reason: input.reason } : {}),
      });
      await this.context(client, eventId, actor.requestId, "whole_order_review");
      await client.query(
        `INSERT INTO rework_tail_completion_reviews(
           completion_review_id,confirmation_id,decision,reviewed_by,reason,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [reviewId, pendingConfirmation.confirmation_id, input.decision, actor.actorId, input.reason ?? null, eventId, actor.requestId],
      );
      if (!approved) {
        await client.query(
          "UPDATE rework_orders SET status='pending_order_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
          [reworkOrderId, actor.actorId],
        );
        await this.todos?.completeOpenByDedupePrefix(client, actor, `final-quantity-ie-review:${reworkOrderId}:`, "IE returned the final quantity confirmation");
        await this.todos?.actionableForUniqueDirectRole(client, actor, {
          category: "whole_order_review",
          sourceEventId: eventId,
          sourceAction: "rework.final_quantity.ie_review",
          entityType: "rework_order",
          entityId: reworkOrderId,
          requiredRole: "tail_supervisor",
          requiredCapability: "submission:audit",
          route: { routeName: "rework_detail", entityId: reworkOrderId, tab: "whole_order_review" },
          policyKey: "general",
          dedupeKey: `whole-order-review:${reworkOrderId}:${order.version + 1}`,
        });
        await this.outbox.enqueue(client, {
          topic: "rework.final_quantity.returned", aggregateType: "rework_order", aggregateId: reworkOrderId,
          payload: { reworkOrderId, reworkNo: order.rework_no, confirmationId: pendingConfirmation.confirmation_id, reason: input.reason },
          recipientKey: "role:tail_supervisor", idempotencyKey: `${reworkOrderId}:final-quantity:${reviewId}:rejected`,
        });
        return this.dto(client, await this.order(client, reworkOrderId, false), await this.permissions(client, actor, order));
      }
      if (pendingConfirmation.price_snapshot_required) {
        await client.query(
          `UPDATE rework_process_configuration_items item
           SET unit_price=price.proposed_unit_price
           FROM rework_tail_completion_prices price
           WHERE price.confirmation_id=$1
             AND price.configuration_item_id=item.configuration_item_id
             AND item.unit_price IS DISTINCT FROM price.proposed_unit_price`,
          [pendingConfirmation.confirmation_id],
        );
      }
      await client.query(
        `WITH amounts AS (
           SELECT share.work_report_id,share.person_id,
                  round(
                    rework_work_report_effective_quantity(report.work_report_id)*item.unit_price*
                    CASE WHEN task.assignment_mode='collective'
                      THEN 1::numeric / NULLIF(count(*) OVER(PARTITION BY share.work_report_id),0)
                      ELSE 1
                    END *
                    CASE WHEN member.person_type_snapshot='temporary'
                      THEN COALESCE(coefficient.multiplier,1)
                      ELSE 1
                    END,
                    8
                  ) AS amount
           FROM rework_work_report_member_shares share
           JOIN rework_work_reports report ON report.work_report_id=share.work_report_id
           JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
           JOIN rework_work_task_members member
             ON member.work_task_id=task.work_task_id AND member.person_id=share.person_id
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=report.configuration_item_id
           LEFT JOIN rework_tail_completion_coefficients coefficient
             ON coefficient.confirmation_id=$1
            AND coefficient.configuration_item_id=report.configuration_item_id
            AND coefficient.person_id=share.person_id
           WHERE report.rework_order_id=$2 AND share.amount=0
             AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
         )
         UPDATE rework_work_report_member_shares share SET amount=amounts.amount
         FROM amounts WHERE share.work_report_id=amounts.work_report_id AND share.person_id=amounts.person_id`,
        [pendingConfirmation.confirmation_id, reworkOrderId],
      );
      await client.query(
        `WITH amounts AS (
           SELECT report.work_report_id,rework_work_report_effective_quantity(report.work_report_id) settlement_quantity,
                  sum(share.amount) group_amount
           FROM rework_work_reports report
           JOIN rework_work_report_member_shares share ON share.work_report_id=report.work_report_id
           WHERE report.rework_order_id=$1 AND report.group_amount=0 AND report.settlement_quantity IS NULL
             AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
           GROUP BY report.work_report_id
         )
         UPDATE rework_work_reports report
         SET settlement_quantity=amounts.settlement_quantity,group_amount=amounts.group_amount
         FROM amounts WHERE report.work_report_id=amounts.work_report_id`,
        [reworkOrderId],
      );
      const plans = await this.plans(client, reworkOrderId);
      const snapshot = await this.snapshot(client, order, plans, pendingConfirmation);
      await client.query(
        "INSERT INTO rework_order_reviews(order_review_id,rework_order_id,reviewed_by,review_snapshot) VALUES($1,$2,$3,$4)",
        [orderReviewId, reworkOrderId, actor.actorId, snapshot],
      );
      await client.query(
        "UPDATE rework_orders SET status='pending_responsibility_determination',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId],
      );
      await this.todos?.completeOpenByDedupePrefix(client, actor, `final-quantity-ie-review:${reworkOrderId}:`, "IE approved the final quantities");
      await this.todos?.actionableForAllDirectRole(client, actor, {
        category: "responsibility_determination",
        sourceEventId: eventId,
        sourceAction: "rework.final_quantity.ie_review",
        entityType: "rework_order",
        entityId: reworkOrderId,
        requiredRole: "production_management",
        requiredCapability: "responsibility:determine",
        route: { routeName: "responsibility_detail", entityId: reworkOrderId },
        policyKey: "general",
        dedupeKey: `responsibility-entry:${reworkOrderId}:${orderReviewId}`,
      });
      return this.dto(client, await this.order(client, reworkOrderId, false), await this.permissions(client, actor, order));
    });
  }

  private async approveLegacy(actor: TrustedActorContext, reworkOrderId: string, input: ReviewWholeOrder, key: string): Promise<Result<WholeOrderReviewResponse>> {
    return this.mutate(actor, "rework.whole_order.approve", key, { reworkOrderId, ...input }, 200, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      await this.ensureOrderWide(actor, "tail_supervisor", "submission:audit", order);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") error("当前返工单尚未进入 N05 尾部核量节点", 409, "INVALID_STATE_TRANSITION");
      const existing = await client.query("SELECT 1 FROM rework_order_reviews WHERE rework_order_id=$1 FOR SHARE", [reworkOrderId]);
      if (existing.rowCount) error("该返工单已经完成整单审核", 409, "CONFLICT");
      const plans = await this.plans(client, reworkOrderId);
      if (plans.some((plan) => plan.unit_price === null)) {
        error("每道工序必须在 N03 完成 IE 核价后才能核量", 409, "INVALID_STATE_TRANSITION");
      }
      if (plans.length === 0) error("当前返工单没有 IE 已核价工序", 409, "INVALID_STATE_TRANSITION");
      await this.assertTailReconciliation(client, reworkOrderId, order.tail_inspection_required);
      const temporaryWorkers = await this.temporaryWorkers(client, reworkOrderId);
      const submittedCoefficientKeys = new Set(input.temporaryCoefficients.map((item) => `${item.configurationItemId}:${item.personId}`));
      const expectedCoefficientKeys = new Set(temporaryWorkers.map((worker) => `${worker.configuration_item_id}:${worker.person_id}`));
      if (submittedCoefficientKeys.size !== expectedCoefficientKeys.size
        || [...expectedCoefficientKeys].some((value) => !submittedCoefficientKeys.has(value))) {
        error("每名临时工每道工序都必须保留一个实发系数；默认填 1.0", 400, "VALIDATION_ERROR");
      }
      const reviewId = randomUUID();
      const completionConfirmationId = randomUUID();
      const eventId = await this.events.append(client, this.withCapability(actor, "submission:audit"), {
        action: "rework.whole_order.approve", entityType: "rework_order", entityId: reworkOrderId,
        before: this.orderAudit(order),
        after: {
          ...this.orderAudit(order, "pending_responsibility_determination", order.version + 1),
          orderReviewId: reviewId,
          completionConfirmationId,
          temporaryCoefficients: input.temporaryCoefficients,
        },
      });
      await this.context(client, eventId, actor.requestId, "whole_order_review");
      const completionTablesAvailable = await this.tailCompletionAvailable(client);
      if (completionTablesAvailable) {
        await client.query(
        `INSERT INTO rework_tail_completion_confirmations(
           confirmation_id,rework_order_id,confirmed_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5)`,
        [completionConfirmationId, reworkOrderId, actor.actorId, eventId, actor.requestId],
      );
        for (const coefficient of input.temporaryCoefficients) {
          await client.query(
          `INSERT INTO rework_tail_completion_coefficients(
             confirmation_id,configuration_item_id,person_id,multiplier,reason
           ) VALUES($1,$2,$3,$4,$5)`,
          [completionConfirmationId, coefficient.configurationItemId, coefficient.personId, coefficient.multiplier, coefficient.reason ?? null],
        );
        }
        await client.query(
        `WITH amounts AS (
           SELECT share.work_report_id,share.person_id,
                  round(
                    report.actual_quantity*item.unit_price*
                    CASE WHEN task.assignment_mode='collective'
                      THEN 1::numeric / NULLIF(count(*) OVER(PARTITION BY share.work_report_id),0)
                      ELSE 1
                    END *
                    CASE WHEN member.person_type_snapshot='temporary'
                      THEN COALESCE(coefficient.multiplier,1)
                      ELSE 1
                    END,
                    8
                  ) AS amount
           FROM rework_work_report_member_shares share
           JOIN rework_work_reports report ON report.work_report_id=share.work_report_id
           JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
           JOIN rework_work_task_members member
             ON member.work_task_id=task.work_task_id AND member.person_id=share.person_id
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=report.configuration_item_id
           LEFT JOIN rework_tail_completion_coefficients coefficient
             ON coefficient.confirmation_id=$1
            AND coefficient.configuration_item_id=report.configuration_item_id
            AND coefficient.person_id=share.person_id
           WHERE report.rework_order_id=$2
             AND share.amount=0
             AND NOT EXISTS (
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
         )
         UPDATE rework_work_report_member_shares share SET amount=amounts.amount
         FROM amounts
         WHERE share.work_report_id=amounts.work_report_id
           AND share.person_id=amounts.person_id`,
        [completionConfirmationId, reworkOrderId],
      );
        await client.query(
        `WITH amounts AS (
           SELECT report.work_report_id,sum(share.amount) AS group_amount
           FROM rework_work_reports report
           JOIN rework_work_report_member_shares share
             ON share.work_report_id=report.work_report_id
           WHERE report.rework_order_id=$1
             AND report.group_amount=0
             AND NOT EXISTS (
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
           GROUP BY report.work_report_id
         )
         UPDATE rework_work_reports report SET group_amount=amounts.group_amount
         FROM amounts WHERE report.work_report_id=amounts.work_report_id`,
          [reworkOrderId],
        );
      }
      const snapshot = await this.snapshot(client, order, plans);
      await client.query(
        "INSERT INTO rework_order_reviews(order_review_id,rework_order_id,reviewed_by,review_snapshot) VALUES($1,$2,$3,$4)",
        [reviewId, reworkOrderId, actor.actorId, snapshot],
      );
      await client.query(
        "UPDATE rework_orders SET status='pending_responsibility_determination',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId],
      );
      const todoFoundationAvailable = this.todos
        && await this.todoFoundationAvailable(client);
      if (todoFoundationAvailable) {
        await this.todos!.completeOpenByDedupePrefix(
          client,
          actor,
          `whole-order-review:${reworkOrderId}:`,
          "Whole-order review was approved",
        );
        const wagePeriods = await client.query<{
          period_id: string;
          period_version: number;
        }>(
          `SELECT DISTINCT period.period_id,period.period_version
           FROM rework_wage_periods period
           JOIN rework_wage_items item ON item.period_id=period.period_id
           WHERE item.order_review_id=$1
             AND period.status='ready_to_lock'
           ORDER BY period.period_id`,
          [reviewId],
        );
        for (const wagePeriod of wagePeriods.rows) {
          await this.todos.cancelOpenByDedupePrefix(
            client,
            actor,
            `wage-tail-review:${wagePeriod.period_id}:`,
            "Tail wage review was removed from the workflow",
          );
          await this.todos.cancelOpenByDedupePrefix(
            client,
            actor,
            `wage-admin-review:${wagePeriod.period_id}:`,
            "Administrative wage review was removed from the workflow",
          );
          await this.todos.cancelOpenByDedupePrefix(
            client,
            actor,
            `wage-month-lock:${wagePeriod.period_id}:`,
            "工资月结已退出当前流程；报表继续用于财务对数",
          );
        }
      }
      if (todoFoundationAvailable) {
        await this.todos!.actionableForAllDirectRole(client, actor, {
          category: "responsibility_determination",
          sourceEventId: eventId,
          sourceAction: "rework.whole_order.approve",
          entityType: "rework_order",
          entityId: reworkOrderId,
          requiredRole: "production_management",
          requiredCapability: "responsibility:determine",
          route: { routeName: "responsibility_detail", entityId: reworkOrderId },
          policyKey: "general",
          dedupeKey: `responsibility-entry:${reworkOrderId}:${reviewId}`,
        });
      }
      return this.dto(client, await this.order(client, reworkOrderId, false), await this.permissions(client, actor, order));
    });
  }

  /**
   * Historical migration replay exercises the pre-PR-13 services against
   * earlier schemas. The injected projection must therefore remain inert
   * until the PR-13 table is actually present, rather than querying a PR-12
   * wage table during that replay.
   */
  private async todoFoundationAvailable(client: PoolClient): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('rework_todos') IS NOT NULL AS available",
    );
    return result.rows[0]?.available === true;
  }

  private async tailCompletionAvailable(
    client: Pick<Pool, "query"> | PoolClient,
  ): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('rework_tail_completion_confirmations') IS NOT NULL AS available",
    );
    return result.rows[0]?.available === true;
  }

  private async finalQuantityReviewAvailable(
    client: Pick<Pool, "query"> | PoolClient,
  ): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('rework_tail_completion_quantities') IS NOT NULL AS available",
    );
    return result.rows[0]?.available === true;
  }

  async correctReportQuantity(
    actor: TrustedActorContext,
    workReportId: string,
    input: CorrectWorkReportQuantity,
    key: string,
  ): Promise<Result<WholeOrderReviewResponse>> {
    return this.mutate(actor, "rework.work_report.quantity_correct", key, { workReportId, ...input }, 200, async (client) => {
      const report = await client.query<{
        work_report_id: string; work_task_id: string; rework_order_id: string; configuration_item_id: string;
        actual_quantity: string; assignment_mode: "individual" | "collective";
        rejected: boolean;
      }>(
        `SELECT report.work_report_id,report.work_task_id,report.rework_order_id,report.configuration_item_id,
                report.actual_quantity::text,task.assignment_mode,
                EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id) AS rejected
         FROM rework_work_reports report
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         WHERE report.work_report_id=$1 AND report.status='submitted'`,
        [workReportId],
      );
      const row = report.rows[0] ?? error("上数记录不存在", 404, "NOT_FOUND");
      const order = await this.order(client, row.rework_order_id, true);
      await this.ensureOrderWide(actor, "tail_supervisor", "submission:audit", order);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") error("只有 N05 尾部最终数量确认可以修正有效上数", 409, "INVALID_STATE_TRANSITION");
      if (row.rejected) error("已驳回的上数记录不能再修正", 409, "CONFLICT");
      const members = await client.query<{ person_id: string | null; member_count: number }>(
        `SELECT (array_agg(member.person_id ORDER BY member.person_id))[1] AS person_id,
                count(member.person_id)::int AS member_count
         FROM rework_work_task_members member WHERE member.work_task_id=$1`,
        [row.work_task_id],
      );
      const member = members.rows[0] ?? { person_id: null, member_count: 0 };
      if (row.assignment_mode !== "individual" || member.member_count !== 1 || !member.person_id) {
        error("历史集体报数无法拆分到个人，请使用原有驳回流程", 409, "CONFLICT");
      }
      const latestCorrection = (await client.query<{ revision_version: number; effective_quantity: string }>(
        `SELECT revision_version,effective_quantity::text
         FROM rework_work_report_quantity_revisions
         WHERE work_report_id=$1 ORDER BY revision_version DESC LIMIT 1`,
        [workReportId],
      )).rows[0];
      const previousEffectiveQuantity = numberValue(latestCorrection?.effective_quantity ?? row.actual_quantity);
      if (previousEffectiveQuantity === input.effectiveQuantity) {
        error("修正后的有效数量没有变化", 409, "CONFLICT");
      }
      const correctionVersion = (latestCorrection?.revision_version ?? 0) + 1;
      const correctionId = randomUUID();
      const eventId = await this.events.append(client, this.withCapability(actor, "submission:audit"), {
        action: "rework.work_report.quantity_correct", entityType: "work_report", entityId: workReportId,
        before: {
          workReportId, reworkOrderId: row.rework_order_id, configurationItemId: row.configuration_item_id,
          personId: member.person_id, originalQuantity: numberValue(row.actual_quantity),
          effectiveQuantity: previousEffectiveQuantity, correctionVersion: latestCorrection?.revision_version ?? 0,
        },
        after: {
          workReportId, reworkOrderId: row.rework_order_id, configurationItemId: row.configuration_item_id,
          personId: member.person_id, originalQuantity: numberValue(row.actual_quantity),
          effectiveQuantity: input.effectiveQuantity, correctionVersion,
        },
      });
      await this.context(client, eventId, actor.requestId, "quantity_correction");
      await client.query(
        `INSERT INTO rework_work_report_quantity_revisions(
           quantity_revision_id,work_report_id,rework_order_id,configuration_item_id,person_id,
           revision_version,original_quantity,effective_quantity,corrected_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [correctionId, workReportId, row.rework_order_id, row.configuration_item_id, member.person_id,
          correctionVersion, numberValue(row.actual_quantity), input.effectiveQuantity, actor.actorId, eventId, actor.requestId],
      );
      return this.dto(client, order, await this.permissions(client, actor, order));
    });
  }

  async correctReportQuantities(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: CorrectWorkReportQuantities,
    key: string,
  ): Promise<Result<WholeOrderReviewResponse>> {
    return this.mutate(actor, "rework.work_report.quantity_correct", key, { reworkOrderId, ...input }, 200, async (client) => {
      const reportIds = input.corrections.map((correction) => correction.workReportId);
      const reports = await client.query<{
        work_report_id: string; work_task_id: string; rework_order_id: string; configuration_item_id: string;
        actual_quantity: string; assignment_mode: "individual" | "collective"; rejected: boolean;
      }>(
        `SELECT report.work_report_id,report.work_task_id,report.rework_order_id,report.configuration_item_id,
                report.actual_quantity::text,task.assignment_mode,
                EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id) AS rejected
         FROM rework_work_reports report
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         WHERE report.work_report_id=ANY($1::uuid[]) AND report.status='submitted'`,
        [reportIds],
      );
      if (reports.rows.length !== reportIds.length) error("部分上数记录不存在", 404, "NOT_FOUND");
      if (reports.rows.some((row) =>
        row.rework_order_id !== reworkOrderId || row.configuration_item_id !== input.configurationItemId)) {
        error("只能批量修正同一订单、同一工序的上数记录", 400, "VALIDATION_ERROR");
      }

      const order = await this.order(client, reworkOrderId, true);
      await this.ensureOrderWide(actor, "tail_supervisor", "submission:audit", order);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") {
        error("只有 N05 尾部最终数量确认可以修正有效上数", 409, "INVALID_STATE_TRANSITION");
      }

      const members = await client.query<{ work_task_id: string; person_id: string | null; member_count: number }>(
        `SELECT task.work_task_id,
                (array_agg(member.person_id ORDER BY member.person_id))[1] AS person_id,
                count(member.person_id)::int AS member_count
         FROM rework_work_tasks task
         LEFT JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
         WHERE task.work_task_id=ANY($1::uuid[])
         GROUP BY task.work_task_id`,
        [reports.rows.map((row) => row.work_task_id)],
      );
      const memberByTask = new Map(members.rows.map((member) => [member.work_task_id, member]));
      const latestCorrections = await client.query<{
        work_report_id: string; revision_version: number; effective_quantity: string;
      }>(
        `SELECT DISTINCT ON (work_report_id) work_report_id,revision_version,effective_quantity::text
         FROM rework_work_report_quantity_revisions
         WHERE work_report_id=ANY($1::uuid[])
         ORDER BY work_report_id,revision_version DESC`,
        [reportIds],
      );
      const latestByReport = new Map(latestCorrections.rows.map((revision) => [revision.work_report_id, revision]));
      const reportById = new Map(reports.rows.map((row) => [row.work_report_id, row]));

      for (const correction of input.corrections) {
        const row = reportById.get(correction.workReportId)!;
        if (row.rejected) error("已驳回的上数记录不能再修正", 409, "CONFLICT");
        const member = memberByTask.get(row.work_task_id) ?? { person_id: null, member_count: 0 };
        if (row.assignment_mode !== "individual" || member.member_count !== 1 || !member.person_id) {
          error("历史集体报数无法拆分到个人，请使用原有驳回流程", 409, "CONFLICT");
        }
        const latestCorrection = latestByReport.get(correction.workReportId);
        const previousEffectiveQuantity = numberValue(latestCorrection?.effective_quantity ?? row.actual_quantity);
        if (previousEffectiveQuantity === correction.effectiveQuantity) {
          error("批量修正包含未变化的有效数量", 409, "CONFLICT");
        }
        const correctionVersion = (latestCorrection?.revision_version ?? 0) + 1;
        const correctionId = randomUUID();
        const eventId = await this.events.append(client, this.withCapability(actor, "submission:audit"), {
          action: "rework.work_report.quantity_correct",
          entityType: "work_report",
          entityId: correction.workReportId,
          before: {
            workReportId: correction.workReportId,
            reworkOrderId,
            configurationItemId: row.configuration_item_id,
            personId: member.person_id,
            originalQuantity: numberValue(row.actual_quantity),
            effectiveQuantity: previousEffectiveQuantity,
            correctionVersion: latestCorrection?.revision_version ?? 0,
          },
          after: {
            workReportId: correction.workReportId,
            reworkOrderId,
            configurationItemId: row.configuration_item_id,
            personId: member.person_id,
            originalQuantity: numberValue(row.actual_quantity),
            effectiveQuantity: correction.effectiveQuantity,
            correctionVersion,
          },
        });
        await this.context(client, eventId, actor.requestId, "quantity_correction");
        await client.query(
          `INSERT INTO rework_work_report_quantity_revisions(
             quantity_revision_id,work_report_id,rework_order_id,configuration_item_id,person_id,
             revision_version,original_quantity,effective_quantity,corrected_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [correctionId, correction.workReportId, reworkOrderId, row.configuration_item_id, member.person_id,
            correctionVersion, numberValue(row.actual_quantity), correction.effectiveQuantity,
            actor.actorId, eventId, actor.requestId],
        );
      }

      return this.dto(client, order, await this.permissions(client, actor, order));
    });
  }

  async rejectReport(actor: TrustedActorContext, workReportId: string, input: RejectWorkReport, key: string): Promise<Result<WholeOrderReviewResponse>> {
    return this.mutate(actor, "rework.work_report.reject", key, { workReportId, ...input }, 200, async (client) => {
      const report = await client.query<ReportRow & { rework_order_id: string }>(
        `SELECT report.work_report_id,report.work_task_id,report.configuration_item_id,report.actual_quantity,report.completed_at,
                report.submitted_by,report.resubmits_work_report_id,report.rework_order_id,
                rejection.report_rejection_id,rejection.rejected_person_id,rejection.reason AS rejection_reason
         FROM rework_work_reports report
         LEFT JOIN rework_work_report_rejections rejection ON rejection.work_report_id=report.work_report_id
         WHERE report.work_report_id=$1 FOR UPDATE OF report`,
        [workReportId],
      );
      const row = report.rows[0]!;
      if (!row) error("上数记录不存在", 404, "NOT_FOUND");
      const order = await this.order(client, row.rework_order_id, true);
      await this.ensureOrderWide(actor, "tail_supervisor", "submission:audit", order);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") error("当前返工单不在整单审核节点", 409, "INVALID_STATE_TRANSITION");
      if (row.report_rejection_id) error("该上数记录已经被驳回", 409, "CONFLICT");
      const task = await client.query<{ assignment_mode: "individual" | "collective" }>("SELECT assignment_mode FROM rework_work_tasks WHERE work_task_id=$1 FOR SHARE", [row.work_task_id]);
      const collective = task.rows[0]?.assignment_mode === "collective";
      if (collective && input.rejectedPersonId !== null) error("集体计件只能驳回整条集体记录", 400, "VALIDATION_ERROR");
      if (!collective) {
        if (!input.rejectedPersonId) error("个人计件必须指定记录对应人员", 400, "VALIDATION_ERROR");
        const member = await client.query("SELECT 1 FROM rework_work_task_members WHERE work_task_id=$1 AND person_id=$2 FOR SHARE", [row.work_task_id, input.rejectedPersonId]);
        if (!member.rowCount) error("只能驳回该上数记录对应人员", 400, "VALIDATION_ERROR");
      }
      const rejectionId = randomUUID();
      const eventId = await this.events.append(client, this.withCapability(actor, "submission:audit"), {
        action: "rework.work_report.reject", entityType: "rework_order", entityId: order.rework_order_id,
        before: { ...this.orderAudit(order), workReportId, actualQuantity: numberValue(row.actual_quantity), rejected: false },
        after: { ...this.orderAudit(order, "in_progress", order.version + 1), workReportId, rejected: true, rejectedPersonId: input.rejectedPersonId, reportRejectionId: rejectionId },
        reason: input.reason,
      });
      await this.context(client, eventId, actor.requestId, "whole_order_review");
      await client.query(
        "INSERT INTO rework_work_report_rejections(report_rejection_id,work_report_id,rework_order_id,rejected_person_id,rejected_by,reason,report_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [rejectionId, workReportId, order.rework_order_id, input.rejectedPersonId, actor.actorId, input.reason, {
          workReportId, workTaskId: row.work_task_id, configurationItemId: row.configuration_item_id,
          actualQuantity: numberValue(row.actual_quantity), completedAt: row.completed_at.toISOString(), submittedBy: row.submitted_by,
        }],
      );
      await client.query(
        "UPDATE rework_orders SET status='in_progress',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1",
        [order.rework_order_id, actor.actorId],
      );
      await this.todos?.cancelOpenByDedupePrefix(
        client,
        actor,
        `whole-order-review:${order.rework_order_id}:`,
        "A work report was returned for correction",
      );
      const originalSubmission = await client.query<{ event_id: string }>(
        `SELECT event_id
         FROM operation_events
         WHERE action='rework.work_report.submit'
           AND after_state->>'workReportId'=$1
         ORDER BY created_at DESC,event_id DESC
         LIMIT 1
         FOR KEY SHARE`,
        [workReportId],
      );
      const originalSubmissionEventId = originalSubmission.rows[0]?.event_id
        ?? error("上数原始操作事件不存在，不能创建可追溯的驳回待办", 409, "CONFLICT");
      await this.todos?.actionableForNamedSourceActor(client, actor, {
        category: "work_report_return",
        sourceEventId: eventId,
        sourceAction: "rework.work_report.reject",
        entityType: "rework_order",
        entityId: order.rework_order_id,
        recipientUserId: row.submitted_by,
        sourceActorEventId: originalSubmissionEventId,
        permittedCapabilities: ["work:report", "work:report_for_worker", "tail_inspection:report"],
        route: {
          routeName: "rework_detail",
          entityId: order.rework_order_id,
          tab: "work_reporting",
        },
        policyKey: "general",
        dedupeKey: `work-report-return:${workReportId}`,
      });
      return this.dto(client, await this.order(client, order.rework_order_id, false), await this.permissions(client, actor, order));
    });
  }

  async decrease(actor: TrustedActorContext, reworkOrderId: string, input: CreateQuantityDecrease, key: string): Promise<Result<QuantityAdjustmentResponse>> {
    return this.mutate(actor, "rework.quantity.decrease", key, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      await this.ensure(actor, "tail_supervisor", "quantity:adjust", order, input.configurationItemId);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "in_progress" && order.status !== "pending_order_review") error("当前返工单不允许减少计划数量", 409, "INVALID_STATE_TRANSITION");
      const item = await this.item(client, reworkOrderId, input.configurationItemId);
      this.ensureQuantityPrecision(item, input.newPlannedQuantity);
      const { currentPlan, completedQuantity, nextVersion } = await this.quantityState(client, reworkOrderId, input.configurationItemId, item.planned_quantity);
      if (input.newPlannedQuantity >= currentPlan) error("减少后的计划数量必须小于当前有效计划数量", 400, "VALIDATION_ERROR");
      if (input.newPlannedQuantity < completedQuantity) error("减少后的计划数量不得低于当前有效上数总量", 409, "CONFLICT");
      const plans = await this.plans(client, reworkOrderId);
      const completedOrder = plans.every((plan) => plan.configuration_item_id === input.configurationItemId
        ? numberValue(plan.completed_quantity) >= input.newPlannedQuantity
        : numberValue(plan.completed_quantity) >= numberValue(plan.planned_quantity));
      const nextOrderStatus = completedOrder ? "pending_order_review" : order.status;
      const adjustmentId = randomUUID();
      const eventId = await this.events.append(client, this.withCapability(actor, "quantity:adjust"), {
        action: "rework.quantity.decrease", entityType: "rework_order", entityId: reworkOrderId,
        before: { ...this.orderAudit(order), configurationItemId: input.configurationItemId, plannedQuantity: currentPlan, completedQuantity },
        after: { ...this.orderAudit(order, nextOrderStatus, order.version + 1), configurationItemId: input.configurationItemId, plannedQuantity: input.newPlannedQuantity, completedQuantity, adjustmentId, adjustmentVersion: nextVersion },
        reason: input.reason,
      });
      await this.context(client, eventId, actor.requestId, "quantity_adjustment");
      await client.query(
        `INSERT INTO rework_process_quantity_adjustments(
           adjustment_id,rework_order_id,configuration_item_id,adjustment_version,adjustment_kind,status,
           previous_planned_quantity,requested_planned_quantity,reason,requires_ie_review,requested_by
         ) VALUES($1,$2,$3,$4,'decrease','effective',$5,$6,$7,false,$8)`,
        [adjustmentId, reworkOrderId, input.configurationItemId, nextVersion, currentPlan, input.newPlannedQuantity, input.reason, actor.actorId],
      );
      await client.query("UPDATE rework_orders SET status=$2,updated_by=$3,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1", [reworkOrderId, nextOrderStatus, actor.actorId]);
      return this.adjustmentDto(client, adjustmentId);
    });
  }

  async requestIncrease(actor: TrustedActorContext, reworkOrderId: string, input: CreateQuantityIncrease, key: string): Promise<Result<QuantityAdjustmentResponse>> {
    return this.mutate(actor, "rework.quantity.increase.request", key, { reworkOrderId, ...input }, 201, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      await this.ensure(actor, "tail_supervisor", "quantity:adjust", order, input.configurationItemId);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") error("只有进入整单审核的返工单可申请增加计划数量", 409, "INVALID_STATE_TRANSITION");
      const expiresAt = new Date(input.expiresAt);
      if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) error("增加申请的确认截止时间必须晚于现在", 400, "VALIDATION_ERROR");
      const item = await this.item(client, reworkOrderId, input.configurationItemId);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", ["dx_rework:quantity-adjustment:" + input.configurationItemId]);
      const active = await client.query(`SELECT 1 FROM rework_process_quantity_adjustments WHERE configuration_item_id=$1 AND adjustment_kind='increase' AND (status='pending_ie_review' OR (status='pending_merchandiser_confirmation' AND expires_at>CURRENT_TIMESTAMP)) LIMIT 1`, [input.configurationItemId]);
      if (active.rowCount) error("该工序已有活动中的计划数量增加申请", 409, "CONFLICT");
      this.ensureQuantityPrecision(item, input.newPlannedQuantity);
      const { currentPlan, nextVersion } = await this.quantityState(client, reworkOrderId, input.configurationItemId, item.planned_quantity);
      if (input.newPlannedQuantity <= currentPlan) error("增加后的计划数量必须大于当前有效计划数量", 400, "VALIDATION_ERROR");
      const adjustmentId = randomUUID();
      const eventId = await this.events.append(client, this.withCapability(actor, "quantity:adjust"), {
        action: "rework.quantity.increase.request", entityType: "rework_order", entityId: reworkOrderId,
        before: { ...this.orderAudit(order), configurationItemId: input.configurationItemId, plannedQuantity: currentPlan },
        after: { ...this.orderAudit(order, "pending_order_review", order.version + 1), configurationItemId: input.configurationItemId, plannedQuantity: currentPlan, requestedPlannedQuantity: input.newPlannedQuantity, adjustmentId, adjustmentVersion: nextVersion, requiresIeReview: true },
        reason: input.reason,
      });
      await this.context(client, eventId, actor.requestId, "quantity_adjustment");
      await client.query(
        `INSERT INTO rework_process_quantity_adjustments(
           adjustment_id,rework_order_id,configuration_item_id,adjustment_version,adjustment_kind,status,
           previous_planned_quantity,requested_planned_quantity,reason,requires_ie_review,expires_at,requested_by
         ) VALUES($1,$2,$3,$4,'increase','pending_merchandiser_confirmation',$5,$6,$7,$8,$9,$10)`,
        [adjustmentId, reworkOrderId, input.configurationItemId, nextVersion, currentPlan, input.newPlannedQuantity, input.reason, true, expiresAt, actor.actorId],
      );
      await client.query("UPDATE rework_orders SET updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1", [reworkOrderId, actor.actorId]);
      await this.outbox.enqueue(client, {
        topic: "rework.quantity.increase.pending_merchandiser_confirmation", aggregateType: "rework_order", aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: order.rework_no, adjustmentId }, recipientKey: "user:" + (order.merchandiser_user_id ?? "unassigned"),
        idempotencyKey: reworkOrderId + ":quantity-increase:" + adjustmentId + ":request",
      });
      return this.adjustmentDto(client, adjustmentId);
    });
  }

  async confirmIncrease(actor: TrustedActorContext, adjustmentId: string, input: ConfirmQuantityIncrease, key: string): Promise<Result<QuantityAdjustmentResponse>> {
    return this.mutate(actor, "rework.quantity.increase.confirm", key, { adjustmentId, ...input }, 200, async (client) => {
      const adjustment = await this.adjustment(client, adjustmentId, true);
      const order = await this.order(client, adjustment.rework_order_id, true);
      await this.ensureConfirm(actor, order, adjustment.configuration_item_id);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      this.ensureAdjustmentVersion(adjustment, input.expectedAdjustmentVersion);
      if (adjustment.adjustment_kind !== "increase" || adjustment.status !== "pending_merchandiser_confirmation") error("该数量调整不等待跟单确认", 409, "INVALID_STATE_TRANSITION");
      if (!isRootActor(actor) && adjustment.requested_by === actor.actorId) error("任何人不得确认自己发起的历史调整", 403, "FORBIDDEN");
      if (!adjustment.expires_at || adjustment.expires_at.getTime() <= Date.now()) error("该增加申请已过期，未改变有效计划数量", 409, "CONFLICT");
      const item = await this.item(client, order.rework_order_id, adjustment.configuration_item_id);
      this.ensureQuantityPrecision(item, input.actualCutQuantity);
      this.ensureQuantityPrecision(item, input.actualReturnQuantity);
      this.ensureQuantityPrecision(item, input.allowedMaximumQuantity);
      if (input.decision === "confirmed" && (
        numberValue(adjustment.requested_planned_quantity) > input.allowedMaximumQuantity
        || numberValue(adjustment.requested_planned_quantity) > input.actualCutQuantity
        || numberValue(adjustment.requested_planned_quantity) > input.actualReturnQuantity
      )) error("申请数量超过跟单确认的实裁、回货或允许上限", 409, "CONFLICT");
      const nextStatus = input.decision === "rejected"
        ? "rejected"
        : adjustment.requires_ie_review ? "pending_ie_review" : "effective";
      const nextOrderStatus = input.decision === "rejected"
        ? "pending_order_review"
        : adjustment.requires_ie_review ? "pending_quantity_adjustment_ie_review" : "in_progress";
      const eventId = await this.events.append(client, this.withCapability(actor, "quantity:confirm"), {
        action: "rework.quantity.increase.confirm", entityType: "rework_order", entityId: order.rework_order_id,
        before: { ...this.orderAudit(order), adjustmentId, adjustmentStatus: adjustment.status, requestedPlannedQuantity: numberValue(adjustment.requested_planned_quantity) },
        after: { ...this.orderAudit(order, nextOrderStatus, order.version + 1), adjustmentId, adjustmentStatus: nextStatus, confirmedMaximumQuantity: input.allowedMaximumQuantity, actualCutQuantity: input.actualCutQuantity, actualReturnQuantity: input.actualReturnQuantity },
        ...(input.reason ? { reason: input.reason } : {}),
      });
      await this.context(client, eventId, actor.requestId, "quantity_adjustment");
      await client.query(
        `UPDATE rework_process_quantity_adjustments
         SET status=$2,confirmed_by=$3,confirmed_at=CURRENT_TIMESTAMP,actual_cut_quantity=$4,
             actual_return_quantity=$5,allowed_maximum_quantity=$6,confirmation_reason=$7
         WHERE adjustment_id=$1`,
        [adjustmentId, nextStatus, actor.actorId, input.actualCutQuantity, input.actualReturnQuantity, input.allowedMaximumQuantity, input.reason ?? null],
      );
      await client.query("UPDATE rework_orders SET status=$2,updated_by=$3,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1", [order.rework_order_id, nextOrderStatus, actor.actorId]);
      if (nextStatus === "pending_ie_review") await this.outbox.enqueue(client, {
        topic: "rework.quantity.increase.pending_ie_review", aggregateType: "rework_order", aggregateId: order.rework_order_id,
        payload: { reworkOrderId: order.rework_order_id, reworkNo: order.rework_no, adjustmentId }, recipientKey: "role:ie_reviewer",
        idempotencyKey: order.rework_order_id + ":quantity-increase:" + adjustmentId + ":ie-review",
      });
      return this.adjustmentDto(client, adjustmentId);
    });
  }

  async reviewIncrease(actor: TrustedActorContext, adjustmentId: string, input: ReviewQuantityIncrease, key: string): Promise<Result<QuantityAdjustmentResponse>> {
    return this.mutate(actor, "rework.quantity.increase.ie_review", key, { adjustmentId, ...input }, 200, async (client) => {
      const adjustment = await this.adjustment(client, adjustmentId, true);
      const order = await this.order(client, adjustment.rework_order_id, true);
      await this.ensure(actor, "ie_reviewer", "process:review", order, adjustment.configuration_item_id);
      this.ensureOrderVersion(order, input.expectedOrderVersion);
      this.ensureAdjustmentVersion(adjustment, input.expectedAdjustmentVersion);
      if (adjustment.status !== "pending_ie_review") error("该数量调整不在IE复核节点", 409, "INVALID_STATE_TRANSITION");
      if (!isRootActor(actor) && adjustment.requested_by === actor.actorId) error("任何人不得审核自己发起的历史调整", 403, "FORBIDDEN");
      const approved = input.decision === "approved";
      const nextOrderStatus = approved ? "in_progress" : "pending_order_review";
      const eventId = await this.events.append(client, this.withCapability(actor, "process:review"), {
        action: "rework.quantity.increase.ie_review", entityType: "rework_order", entityId: order.rework_order_id,
        before: { ...this.orderAudit(order), adjustmentId, adjustmentStatus: adjustment.status },
        after: { ...this.orderAudit(order, nextOrderStatus, order.version + 1), adjustmentId, adjustmentStatus: approved ? "effective" : "rejected" },
        ...(input.reason ? { reason: input.reason } : {}),
      });
      await this.context(client, eventId, actor.requestId, "quantity_adjustment");
      await client.query(
        "UPDATE rework_process_quantity_adjustments SET status=$2,reviewed_by=$3,reviewed_at=CURRENT_TIMESTAMP,review_reason=$4 WHERE adjustment_id=$1",
        [adjustmentId, approved ? "effective" : "rejected", actor.actorId, input.reason ?? null],
      );
      await client.query("UPDATE rework_orders SET status=$2,updated_by=$3,updated_at=CURRENT_TIMESTAMP,version=version+1 WHERE rework_order_id=$1", [order.rework_order_id, nextOrderStatus, actor.actorId]);
      return this.adjustmentDto(client, adjustmentId);
    });
  }

  private async dto(
    client: Pick<Pool, "query"> | PoolClient,
    order: OrderRow,
    permissions: Readonly<{ canReview: boolean; canIeReview: boolean; canAdjustQuantity: boolean; canConfirmQuantity: boolean; canReviewQuantityIncrease: boolean }>,
    configurationItemId?: string,
  ): Promise<WholeOrderReviewResponse> {
    const plans = await this.plans(client, order.rework_order_id);
    const [reports, reviews, temporaryWorkers, unifiedExecutionRequired, finalConfirmation] = await Promise.all([
      this.reports(client, order.rework_order_id, configurationItemId),
      configurationItemId
        ? Promise.resolve({ rows: [] as Array<{ order_review_id: string }> })
        : client.query<{ order_review_id: string }>("SELECT order_review_id FROM rework_order_reviews WHERE rework_order_id=$1", [order.rework_order_id]),
      this.temporaryWorkers(client, order.rework_order_id, configurationItemId),
      this.unifiedExecutionRequired(client, order.rework_order_id),
      configurationItemId ? Promise.resolve(null) : this.finalQuantityReviewAvailable(client).then((available) => available ? this.currentConfirmation(client, order.rework_order_id, false) : null),
    ]);
    return {
      reworkOrderId: order.rework_order_id, reworkStatus: order.status as WholeOrderReviewResponse["reworkStatus"], orderVersion: order.version,
      ...permissions, unifiedExecutionRequired, tailInspectionRequired: order.tail_inspection_required,
      processes: plans.filter((plan) => !configurationItemId || plan.configuration_item_id === configurationItemId).map((plan) => ({
        configurationItemId: plan.configuration_item_id, processName: plan.process_name, pricingUnit: plan.pricing_unit,
        plannedQuantity: numberValue(plan.planned_quantity),
        originalCompletedQuantity: numberValue(plan.original_completed_quantity), completedQuantity: numberValue(plan.completed_quantity),
        originalTailCheckedQuantity: numberValue(plan.original_tail_checked_quantity), tailCheckedQuantity: numberValue(plan.tail_checked_quantity),
        countGap: order.tail_inspection_required ? numberValue(plan.completed_quantity) - numberValue(plan.tail_checked_quantity) : 0,
        complete: order.tail_inspection_required
          ? numberValue(plan.completed_quantity) > 0
            && numberValue(plan.tail_checked_quantity) > 0
            && numberValue(plan.completed_quantity) <= numberValue(plan.tail_checked_quantity)
          : numberValue(plan.completed_quantity) > 0,
        finalUnitPrice: plan.unit_price === null ? null : numberValue(plan.unit_price),
      })),
      reports,
      adjustments: [],
      temporaryWorkers: temporaryWorkers.map((worker) => ({ configurationItemId: worker.configuration_item_id, processName: worker.process_name, personId: worker.person_id, displayName: worker.display_name, multiplier: numberValue(worker.multiplier ?? "1"), reason: worker.reason })),
      reviewId: reviews.rows[0]?.order_review_id ?? null,
      finalConfirmation: finalConfirmation ? await this.confirmationDto(client, finalConfirmation) : null,
    };
  }

  private async snapshot(client: PoolClient, order: OrderRow, plans: readonly PlanRow[], confirmation?: FinalConfirmationRow): Promise<Record<string, unknown>> {
    return {
      order: this.orderAudit(order),
      processes: plans.map((plan) => ({
        configurationItemId: plan.configuration_item_id, processName: plan.process_name, pricingUnit: plan.pricing_unit,
        workerOriginalQuantity: numberValue(plan.original_completed_quantity), workerEffectiveQuantity: numberValue(plan.completed_quantity),
        tailOriginalQuantity: numberValue(plan.original_tail_checked_quantity), tailEffectiveQuantity: numberValue(plan.tail_checked_quantity),
      })),
      finalConfirmation: confirmation ? await this.confirmationDto(client, confirmation) : null,
      reports: await this.reports(client, order.rework_order_id),
    };
  }

  private async currentConfirmation(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, locked: boolean): Promise<FinalConfirmationRow | null> {
    const result = await client.query<FinalConfirmationRow>(
      `SELECT confirmation.confirmation_id,confirmation.confirmation_version,confirmation.confirmed_by,confirmation.confirmed_at,
              confirmation.workflow_stage,confirmation.price_snapshot_required,
              review.decision,review.reviewed_by,review.reviewed_at,review.reason AS review_reason
       FROM rework_tail_completion_confirmations confirmation
       LEFT JOIN rework_tail_completion_reviews review ON review.confirmation_id=confirmation.confirmation_id
       WHERE confirmation.rework_order_id=$1
       ORDER BY confirmation.confirmation_version DESC
       LIMIT 1${locked ? " FOR UPDATE OF confirmation" : ""}`,
      [reworkOrderId],
    );
    return result.rows[0] ?? null;
  }

  private async confirmationDto(client: Pick<Pool, "query"> | PoolClient, confirmation: FinalConfirmationRow): Promise<NonNullable<WholeOrderReviewResponse["finalConfirmation"]>> {
    const prices = await this.confirmationPrices(client, confirmation.confirmation_id);
    const quantities = await client.query<FinalQuantityRow>(
      `SELECT configuration_item_id,worker_reported_quantity::text,tail_reported_quantity::text,final_confirmed_quantity::text
       FROM rework_tail_completion_quantities WHERE confirmation_id=$1 ORDER BY configuration_item_id`,
      [confirmation.confirmation_id],
    );
    return {
      confirmationId: confirmation.confirmation_id,
      confirmationVersion: confirmation.confirmation_version,
      status: confirmation.decision ?? (confirmation.workflow_stage === "approved" ? "approved" : "pending_ie_review"),
      confirmedBy: confirmation.confirmed_by,
      confirmedAt: confirmation.confirmed_at.toISOString(),
      reviewedBy: confirmation.reviewed_by,
      reviewedAt: iso(confirmation.reviewed_at),
      reviewReason: confirmation.review_reason,
      prices: prices.map((price) => ({
        configurationItemId: price.configuration_item_id,
        originalUnitPrice: numberValue(price.original_unit_price),
        proposedUnitPrice: numberValue(price.proposed_unit_price),
        changed: numberValue(price.original_unit_price) !== numberValue(price.proposed_unit_price),
      })),
      quantities: quantities.rows.map((quantity) => ({
        configurationItemId: quantity.configuration_item_id,
        workerReportedQuantity: numberValue(quantity.worker_reported_quantity),
        tailReportedQuantity: numberValue(quantity.tail_reported_quantity),
        finalConfirmedQuantity: numberValue(quantity.final_confirmed_quantity),
        changed: numberValue(quantity.worker_reported_quantity) !== numberValue(quantity.final_confirmed_quantity),
      })),
    };
  }

  private async confirmationPrices(
    client: Pick<Pool, "query"> | PoolClient,
    confirmationId: string,
  ): Promise<FinalPriceRow[]> {
    const result = await client.query<FinalPriceRow>(
      `SELECT configuration_item_id,original_unit_price::text,proposed_unit_price::text
       FROM rework_tail_completion_prices
       WHERE confirmation_id=$1
       ORDER BY configuration_item_id`,
      [confirmationId],
    );
    return result.rows;
  }

  private async plans(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string): Promise<PlanRow[]> {
    const usesUnifiedTailReports = await this.usesUnifiedTailReports(client, reworkOrderId);
    const result = await client.query<PlanRow>(
      `SELECT item.configuration_item_id,item.process_name,item.pricing_unit,item.unit_price,
              item.planned_quantity::text AS planned_quantity,
              COALESCE(completed.original_quantity,0)::text AS original_completed_quantity,
              COALESCE(completed.effective_quantity,0)::text AS completed_quantity,
              COALESCE(CASE WHEN $2::boolean
                THEN unified_tail.original_quantity ELSE legacy_tail.quantity END,0)::text AS original_tail_checked_quantity,
              COALESCE(CASE WHEN $2::boolean
                THEN unified_tail.effective_quantity ELSE legacy_tail.quantity END,0)::text AS tail_checked_quantity
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
       LEFT JOIN LATERAL (
         SELECT sum(report.actual_quantity) AS original_quantity,
                sum(rework_work_report_effective_quantity(report.work_report_id)) AS effective_quantity
         FROM rework_work_reports report
         WHERE report.rework_order_id=$1 AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
           AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       ) completed ON true
       LEFT JOIN LATERAL (
         SELECT sum(report.actual_quantity) AS original_quantity,
                sum(rework_work_report_effective_quantity(report.work_report_id)) AS effective_quantity
         FROM rework_work_reports report
         JOIN rework_process_configuration_items tail_item
           ON tail_item.configuration_item_id=report.configuration_item_id
          AND tail_item.execution_kind='tail_inspection'
         WHERE report.rework_order_id=$1 AND report.status='submitted'
           AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       ) unified_tail ON true
       LEFT JOIN LATERAL (
         SELECT sum(report_item.inspected_quantity) AS quantity
         FROM rework_tail_inspection_report_items report_item
         JOIN rework_tail_inspection_reports report
           ON report.tail_inspection_report_id=report_item.tail_inspection_report_id
          AND report.status='submitted'
         JOIN rework_tail_inspection_assignments assignment
           ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id
          AND assignment.revoked_at IS NULL
         WHERE report.rework_order_id=$1
           AND report_item.configuration_item_id=item.configuration_item_id
       ) legacy_tail ON true
       WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
         AND item.execution_kind='worker'
       ORDER BY item.position,item.configuration_item_id`,
      [reworkOrderId, usesUnifiedTailReports],
    );
    return result.rows;
  }

  private async assertTailReconciliation(client: PoolClient, reworkOrderId: string, tailInspectionRequired: boolean): Promise<void> {
    if (!tailInspectionRequired) {
      const pendingExecution = await client.query(
        `SELECT 1 FROM rework_work_tasks task
         WHERE task.rework_order_id=$1 AND task.status='active'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_reports report
             WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
               AND NOT EXISTS(
                 SELECT 1 FROM rework_work_report_rejections rejection
                 WHERE rejection.work_report_id=report.work_report_id
               )
           )
         LIMIT 1`,
        [reworkOrderId],
      );
      if (pendingExecution.rowCount) error("仍有返工执行报数未完成，不能整单确认", 409, "CONFLICT");
      return;
    }
    const usesUnifiedTailReports = await this.usesUnifiedTailReports(client, reworkOrderId);
    const pending = await client.query<{ execution_pending: boolean; legacy_tail_pending: boolean }>(
      `SELECT
         EXISTS(
           SELECT 1 FROM rework_work_tasks task
           WHERE task.rework_order_id=$1 AND task.status='active'
             AND NOT EXISTS(
               SELECT 1 FROM rework_work_reports report
               WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
                 AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
             )
         ) AS execution_pending,
         EXISTS(
           SELECT 1 FROM rework_process_configurations configuration
           JOIN rework_tail_inspection_assignments assignment ON assignment.rework_order_id=configuration.rework_order_id
           WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
             AND NOT $2::boolean AND assignment.revoked_at IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM rework_tail_inspection_reports report
               WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id AND report.status='submitted'
             )
         ) AS legacy_tail_pending`,
      [reworkOrderId, usesUnifiedTailReports],
    );
    if (pending.rows[0]?.execution_pending) error("仍有返工执行报数未完成，不能整单确认", 409, "CONFLICT");
    if (pending.rows[0]?.legacy_tail_pending) error("历史订单仍有整查报数未完成，不能整单确认", 409, "CONFLICT");
    const overLimit = await client.query<{ process_name: string }>(
      `WITH active_configuration AS (
         SELECT configuration_id,unified_execution_required
         FROM rework_process_configurations
         WHERE rework_order_id=$1 AND status='approved'
         LIMIT 1
       ), unified_tail AS (
         SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
         FROM rework_work_reports report
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=report.configuration_item_id
          AND item.execution_kind='tail_inspection'
         WHERE report.rework_order_id=$1 AND report.status='submitted'
           AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       )
       SELECT item.process_name
       FROM active_configuration active
       JOIN rework_process_configuration_items item ON item.configuration_id=active.configuration_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
         FROM rework_work_reports report
         WHERE report.rework_order_id=$1 AND report.configuration_item_id=item.configuration_item_id
           AND report.status='submitted'
           AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       ) worker ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(report_item.inspected_quantity),0) AS quantity
         FROM rework_tail_inspection_report_items report_item
         JOIN rework_tail_inspection_reports report
           ON report.tail_inspection_report_id=report_item.tail_inspection_report_id AND report.status='submitted'
         JOIN rework_tail_inspection_assignments assignment
           ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id AND assignment.revoked_at IS NULL
         WHERE report.rework_order_id=$1 AND report_item.configuration_item_id=item.configuration_item_id
       ) legacy_tail ON true
       CROSS JOIN unified_tail
       WHERE item.execution_kind='worker'
         AND worker.quantity > CASE WHEN $2::boolean THEN unified_tail.quantity ELSE legacy_tail.quantity END`,
      [reworkOrderId, usesUnifiedTailReports],
    );
    if (!usesUnifiedTailReports) {
      if (overLimit.rows.length > 0) {
        error(`返工上数超过整查数量：${overLimit.rows.map((row) => row.process_name).join("、")}；请驳回并调整报数`, 409, "CONFLICT");
      }
      return;
    }
    const mismatches = (await this.plans(client, reworkOrderId)).filter((plan) =>
      numberValue(plan.completed_quantity) <= 0
      || numberValue(plan.tail_checked_quantity) <= 0
      || numberValue(plan.completed_quantity) > numberValue(plan.tail_checked_quantity));
    if (mismatches.length > 0) {
      error(`工序有效数量超过整查数量或报数无效：${mismatches.map((plan) => `${plan.process_name} ${plan.completed_quantity}/${plan.tail_checked_quantity}`).join("、")}`, 409, "CONFLICT");
    }
  }

  private async reports(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, configurationItemId?: string): Promise<WholeOrderReviewResponse["reports"]> {
    const [reports, members] = await Promise.all([
      client.query<ReportRow>(
        `SELECT report.work_report_id,report.work_task_id,report.configuration_item_id,report.actual_quantity,
                COALESCE(correction.effective_quantity,report.actual_quantity)::text AS effective_quantity,
                correction.revision_version AS correction_version,correction.corrected_by,correction.corrected_at,
                report.completed_at,report.submitted_by,report.resubmits_work_report_id,
                task.assignment_mode,item.execution_kind,rejection.report_rejection_id,rejection.rejected_person_id,rejection.reason AS rejection_reason
         FROM rework_work_reports report
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id
         LEFT JOIN rework_work_report_rejections rejection ON rejection.work_report_id=report.work_report_id
         LEFT JOIN LATERAL (
           SELECT revision.effective_quantity,revision.revision_version,revision.corrected_by,revision.corrected_at
           FROM rework_work_report_quantity_revisions revision
           WHERE revision.work_report_id=report.work_report_id
           ORDER BY revision.revision_version DESC LIMIT 1
         ) correction ON true
         WHERE report.rework_order_id=$1 AND ($2::uuid IS NULL OR report.configuration_item_id=$2) ORDER BY report.completed_at,report.work_report_id`,
        [reworkOrderId, configurationItemId ?? null],
      ),
      client.query<MemberRow>(
        `SELECT share.work_report_id,person.person_id,member.display_name_snapshot AS display_name
         FROM rework_work_report_member_shares share
         JOIN rework_work_reports report ON report.work_report_id=share.work_report_id
         JOIN rework_work_task_members member ON member.work_task_id=report.work_task_id AND member.person_id=share.person_id
         JOIN business_people person ON person.person_id=share.person_id
         WHERE report.rework_order_id=$1 AND ($2::uuid IS NULL OR report.configuration_item_id=$2) ORDER BY share.work_report_id,person.person_id`,
        [reworkOrderId, configurationItemId ?? null],
      ),
    ]);
    const membersByReport = new Map<string, Array<{ personId: string; displayName: string }>>();
    for (const member of members.rows) {
      const value = membersByReport.get(member.work_report_id) ?? [];
      value.push({ personId: member.person_id, displayName: member.display_name });
      membersByReport.set(member.work_report_id, value);
    }
    return reports.rows.map((report) => ({
      workReportId: report.work_report_id, workTaskId: report.work_task_id, configurationItemId: report.configuration_item_id,
      actualQuantity: numberValue(report.actual_quantity), effectiveQuantity: numberValue(report.effective_quantity),
      corrected: report.correction_version !== null, correctionVersion: report.correction_version,
      correctedBy: report.corrected_by, correctedAt: iso(report.corrected_at),
      completedAt: report.completed_at.toISOString(), submittedBy: report.submitted_by,
      members: membersByReport.get(report.work_report_id) ?? [], assignmentMode: report.assignment_mode, executionKind: report.execution_kind,
      rejected: report.report_rejection_id !== null,
      rejectedPersonId: report.rejected_person_id, rejectionReason: report.rejection_reason, resubmitsWorkReportId: report.resubmits_work_report_id,
    }));
  }

  private async unifiedExecutionRequired(
    client: Pick<Pool, "query"> | PoolClient,
    reworkOrderId: string,
  ): Promise<boolean> {
    const result = await client.query<{ unified_execution_required: boolean }>(
      `SELECT unified_execution_required
       FROM rework_process_configurations
       WHERE rework_order_id=$1 AND status='approved'
       LIMIT 1`,
      [reworkOrderId],
    );
    return result.rows[0]?.unified_execution_required === true;
  }

  private async usesUnifiedTailReports(
    client: Pick<Pool, "query"> | PoolClient,
    reworkOrderId: string,
  ): Promise<boolean> {
    const result = await client.query<{ uses_unified_tail_reports: boolean }>(
      `SELECT COALESCE((
         SELECT configuration.unified_execution_required
         FROM rework_process_configurations configuration
         WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
         LIMIT 1
       ),false) OR EXISTS(
         SELECT 1
         FROM rework_work_reports report
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=report.configuration_item_id
          AND item.execution_kind='tail_inspection'
         JOIN rework_process_configurations configuration
           ON configuration.configuration_id=item.configuration_id
          AND configuration.rework_order_id=report.rework_order_id
          AND configuration.status='approved'
         WHERE report.rework_order_id=$1 AND report.status='submitted'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_report_rejections rejection
             WHERE rejection.work_report_id=report.work_report_id
           )
       ) AS uses_unified_tail_reports`,
      [reworkOrderId],
    );
    return result.rows[0]?.uses_unified_tail_reports === true;
  }

  private async adjustments(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, configurationItemId?: string): Promise<QuantityAdjustmentResponse[]> {
    const result = await client.query<AdjustmentRow>(
      `SELECT adjustment_id,configuration_item_id,adjustment_version,adjustment_kind,status,previous_planned_quantity,
              requested_planned_quantity,reason,requires_ie_review,expires_at,requested_by,requested_at,
              confirmed_by,confirmed_at,reviewed_by,reviewed_at
       FROM rework_process_quantity_adjustments WHERE rework_order_id=$1 AND ($2::uuid IS NULL OR configuration_item_id=$2) ORDER BY requested_at,adjustment_id`,
      [reworkOrderId, configurationItemId ?? null],
    );
    return result.rows.map((row) => this.adjustmentRow(row));
  }

  private async temporaryWorkers(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, configurationItemId?: string): Promise<TemporaryWorkerRow[]> {
    const completionTablesAvailable = await this.tailCompletionAvailable(client);
    const result = await client.query<TemporaryWorkerRow>(
      completionTablesAvailable
        ? `WITH latest AS (
         SELECT confirmation_id FROM rework_tail_completion_confirmations
         WHERE rework_order_id=$1 ORDER BY confirmed_at DESC,confirmation_id DESC LIMIT 1
       )
       SELECT DISTINCT report.configuration_item_id,item.process_name,member.person_id,member.display_name_snapshot AS display_name,
              coefficient.multiplier::text,coefficient.reason
       FROM rework_work_reports report
       JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
       JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id AND member.person_type_snapshot='temporary'
       JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
       LEFT JOIN latest ON true
       LEFT JOIN rework_tail_completion_coefficients coefficient
         ON coefficient.confirmation_id=latest.confirmation_id
        AND coefficient.configuration_item_id=report.configuration_item_id AND coefficient.person_id=member.person_id
       WHERE report.rework_order_id=$1 AND ($2::uuid IS NULL OR report.configuration_item_id=$2)
         AND report.status='submitted'
         AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       ORDER BY item.process_name,member.display_name_snapshot,member.person_id`
        : `SELECT DISTINCT report.configuration_item_id,item.process_name,
                 member.person_id,member.display_name_snapshot AS display_name,
                 NULL::text AS multiplier,NULL::text AS reason
           FROM rework_work_reports report
           JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
           JOIN rework_work_task_members member
             ON member.work_task_id=task.work_task_id
            AND member.person_type_snapshot='temporary'
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=report.configuration_item_id
           WHERE report.rework_order_id=$1
             AND ($2::uuid IS NULL OR report.configuration_item_id=$2)
             AND report.status='submitted'
             AND NOT EXISTS (
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
           ORDER BY item.process_name,member.display_name_snapshot,member.person_id`,
      [reworkOrderId, configurationItemId ?? null],
    );
    return result.rows;
  }

  private async adjustmentDto(client: Pick<Pool, "query"> | PoolClient, adjustmentId: string): Promise<QuantityAdjustmentResponse> {
    const adjustment = await this.adjustment(client, adjustmentId, false);
    return this.adjustmentRow(adjustment);
  }

  private adjustmentRow(row: AdjustmentRow): QuantityAdjustmentResponse {
    const status = row.status === "pending_merchandiser_confirmation"
      && row.expires_at !== null && row.expires_at.getTime() <= Date.now()
      ? "expired" : row.status;
    return {
      adjustmentId: row.adjustment_id, configurationItemId: row.configuration_item_id, adjustmentVersion: row.adjustment_version,
      kind: row.adjustment_kind, status, previousPlannedQuantity: numberValue(row.previous_planned_quantity),
      requestedPlannedQuantity: numberValue(row.requested_planned_quantity), reason: row.reason, requiresIeReview: row.requires_ie_review,
      expiresAt: iso(row.expires_at), requestedBy: row.requested_by, requestedAt: row.requested_at.toISOString(),
      confirmedBy: row.confirmed_by, confirmedAt: iso(row.confirmed_at), reviewedBy: row.reviewed_by, reviewedAt: iso(row.reviewed_at),
    };
  }

  private async item(client: PoolClient, reworkOrderId: string, configurationItemId: string): Promise<ItemRow> {
    const result = await client.query<ItemRow>(
      `SELECT item.configuration_item_id,item.execution_kind,item.pricing_unit,item.planned_quantity
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
       WHERE configuration.rework_order_id=$1 AND configuration.status='approved' AND item.configuration_item_id=$2
       FOR UPDATE OF item`,
      [reworkOrderId, configurationItemId],
    );
    const item = result.rows[0] ?? error("工序不存在或尚未生效", 404, "NOT_FOUND");
    if (item.execution_kind === "tail_inspection") error("整查工序使用实际报数，不参与计划数量调整", 409, "INVALID_STATE_TRANSITION");
    return item;
  }

  private async quantityState(client: PoolClient, reworkOrderId: string, configurationItemId: string, basePlan: string): Promise<{ currentPlan: number; completedQuantity: number; nextVersion: number }> {
    const [adjustments, completed] = await Promise.all([
      client.query<{ requested_planned_quantity: string; adjustment_version: number }>(
        `SELECT requested_planned_quantity,adjustment_version FROM rework_process_quantity_adjustments
         WHERE rework_order_id=$1 AND configuration_item_id=$2 AND status='effective'
         ORDER BY adjustment_version DESC LIMIT 1 FOR UPDATE`,
        [reworkOrderId, configurationItemId],
      ),
      client.query<{ quantity: string; version: number }>(
        `SELECT COALESCE(sum(report.actual_quantity),0)::text AS quantity,
                COALESCE((SELECT max(adjustment_version) FROM rework_process_quantity_adjustments WHERE rework_order_id=$1 AND configuration_item_id=$2),0)::int AS version
         FROM rework_work_reports report
         WHERE report.rework_order_id=$1 AND report.configuration_item_id=$2 AND report.status='submitted'
           AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)`,
        [reworkOrderId, configurationItemId],
      ),
    ]);
    return {
      currentPlan: numberValue(adjustments.rows[0]?.requested_planned_quantity ?? basePlan),
      completedQuantity: numberValue(completed.rows[0]?.quantity ?? "0"), nextVersion: (completed.rows[0]?.version ?? 0) + 1,
    };
  }

  private async adjustment(client: Pick<Pool, "query"> | PoolClient, adjustmentId: string, locked: boolean): Promise<AdjustmentForUpdate> {
    const result = await client.query<AdjustmentForUpdate>(
      `SELECT adjustment_id,rework_order_id,configuration_item_id,adjustment_version,adjustment_kind,status,
              previous_planned_quantity,requested_planned_quantity,reason,requires_ie_review,expires_at,requested_by,requested_at,
              confirmed_by,confirmed_at,reviewed_by,reviewed_at,confirmation_reason
       FROM rework_process_quantity_adjustments WHERE adjustment_id=$1${locked ? " FOR UPDATE" : ""}`,
      [adjustmentId],
    );
    return result.rows[0] ?? error("数量调整不存在", 404, "NOT_FOUND");
  }

  private capabilities(actor: TrustedActorContext): readonly string[] {
    return actor.authorizationCapabilities ?? [actor.authorizationCapability];
  }

  private withCapability(actor: TrustedActorContext, capability: string): TrustedActorContext {
    return { ...actor, authorizationCapability: capability };
  }

  private async permissions(client: Pick<Pool, "query"> | PoolClient, actor: TrustedActorContext, order: OrderRow) {
    return {
      canReview: await this.canOrderWide(actor, "tail_supervisor", "submission:audit", order, client),
      canIeReview: await this.canOrderWide(actor, "ie_reviewer", "process:review", order, client),
      canAdjustQuantity: false,
      canConfirmQuantity: false,
      canReviewQuantityIncrease: false,
    };
  }

  private async ensure(actor: TrustedActorContext, role: string, capability: string, order: OrderRow, configurationItemId?: string): Promise<void> {
    if (!await this.can(actor, role, capability, order, configurationItemId)) error("当前用户无权执行该操作", 403, "FORBIDDEN");
  }

  private async ensureOrderWide(actor: TrustedActorContext, role: string, capability: string, order: OrderRow): Promise<void> {
    if (!await this.canOrderWide(actor, role, capability, order)) error("当前用户无权执行该操作", 403, "FORBIDDEN");
  }

  private async can(actor: TrustedActorContext, role: string, capability: string, order: OrderRow, configurationItemId?: string, client: Pick<Pool, "query"> | PoolClient = this.database): Promise<boolean> {
    if (isRootActor(actor)) return true;
    if (actor.actorRoles.includes(role) && this.capabilities(actor).includes(capability)) return true;
    return this.hasDelegation(client, actor.actorId, capability, order, configurationItemId);
  }

  private async canOrderWide(actor: TrustedActorContext, role: string, capability: string, order: OrderRow, client: Pick<Pool, "query"> | PoolClient = this.database): Promise<boolean> {
    return this.can(actor, role, capability, order, undefined, client);
  }

  private async ensureConfirm(actor: TrustedActorContext, order: OrderRow, configurationItemId?: string): Promise<void> {
    if (!await this.canConfirm(actor, order, configurationItemId)) error("只有该返工单绑定的订单跟单或其有效代理可以确认", 403, "FORBIDDEN");
  }

  private async canConfirm(actor: TrustedActorContext, order: OrderRow, configurationItemId?: string, client: Pick<Pool, "query"> | PoolClient = this.database): Promise<boolean> {
    if (isRootActor(actor)) return true;
    if (!order.merchandiser_user_id) return false;
    if (actor.actorId === order.merchandiser_user_id && actor.actorRoles.includes("order_merchandiser") && this.capabilities(actor).includes("quantity:confirm")) return true;
    return this.hasDelegation(client, actor.actorId, "quantity:confirm", order, configurationItemId, order.merchandiser_user_id);
  }

  private async hasDelegation(client: Pick<Pool, "query"> | PoolClient, actorId: string, capability: string, order: OrderRow, configurationItemId?: string, grantorId?: string): Promise<boolean> {
    const result = await client.query<{ permitted: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM delegated_authorizations delegation
         JOIN app_users grantor ON grantor.id=delegation.grantor_user_id AND grantor.enabled=true
         WHERE delegation.grantee_user_id=$1 AND delegation.capability=$2 AND delegation.revoked_at IS NULL
           AND delegation.valid_from<=CURRENT_TIMESTAMP AND delegation.valid_until>CURRENT_TIMESTAMP
           AND ($6::uuid IS NULL OR delegation.grantor_user_id=$6::uuid)
           AND EXISTS (SELECT 1 FROM identity_mappings identity WHERE identity.user_id=grantor.id AND identity.provider='dingtalk' AND identity.active=true AND identity.employed=true)
           AND EXISTS (
             SELECT 1 FROM user_role_assignments assignment
             JOIN business_roles role ON role.role_code=assignment.role_code AND role.enabled=true
             JOIN role_capabilities role_capability ON role_capability.role_code=assignment.role_code
             WHERE assignment.user_id=delegation.grantor_user_id AND assignment.revoked_at IS NULL AND role_capability.capability=delegation.capability
           )
           AND (
             (delegation.scope_type='global' AND delegation.scope_id IS NULL)
             OR (delegation.scope_type='rework_order' AND delegation.scope_id=$3)
             OR (delegation.scope_type='process' AND delegation.scope_id=$4)
             OR (delegation.scope_type='supplier' AND $5::text IS NOT NULL AND delegation.scope_id=$5::text)
           )
       ) AS permitted`,
      [actorId, capability, order.rework_order_id, configurationItemId ?? null, order.processing_factory_supplier_id, grantorId ?? null],
    );
    return result.rows[0]?.permitted === true;
  }

  private ensureOrderVersion(order: OrderRow, expected: number): void {
    if (order.version !== expected) error("返工单已被其他操作更新，请刷新后重试", 409, "CONFLICT");
  }

  private ensureAdjustmentVersion(adjustment: AdjustmentRow, expected: number): void {
    if (adjustment.adjustment_version !== expected) error("数量调整已被其他操作更新，请刷新后重试", 409, "CONFLICT");
  }

  private ensureQuantityPrecision(_item: ItemRow, quantity: number): void {
    if (!/^(?:0|[1-9]\d*)(?:\.\d)?$/.test(String(quantity))) error("计划数量最多保留一位小数", 400, "VALIDATION_ERROR");
  }

  private orderAudit(order: OrderRow, status = order.status, version = order.version): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id, reworkNo: order.rework_no, status, styleNo: order.style_no, orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory"
        ? { type: "own_factory" }
        : { type: "supplier", supplierId: order.processing_factory_supplier_id, supplierVersion: order.processing_factory_supplier_version },
      problemPart: order.problem_part, problemDescription: order.problem_description, reworkQuantity: order.rework_quantity, version,
    };
  }

  private async order(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, locked: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,problem_part,problem_description,rework_quantity,tail_inspection_required FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted'${locked ? " FOR UPDATE" : ""}`,
      [reworkOrderId],
    );
    return result.rows[0] ?? error("返工单不存在", 404, "NOT_FOUND");
  }

  private async context(client: PoolClient, eventId: string, requestId: string, kind: "whole_order_review" | "quantity_adjustment" | "quantity_correction"): Promise<void> {
    const whole = kind === "whole_order_review" ? eventId : "";
    const quantity = kind === "quantity_adjustment" ? eventId : "";
    const correction = kind === "quantity_correction" ? eventId : "";
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true),set_config('dx_rework.whole_order_review_event_id',$3,true),set_config('dx_rework.whole_order_review_request_id',$2,true),set_config('dx_rework.quantity_adjustment_event_id',$4,true),set_config('dx_rework.quantity_adjustment_request_id',$2,true),set_config('dx_rework.quantity_correction_event_id',$5,true),set_config('dx_rework.quantity_correction_request_id',$2,true)",
      [eventId, requestId, whole, quantity, correction],
    );
  }

  private async mutate<T>(actor: TrustedActorContext, scope: string, key: string, payload: unknown, statusCode: number, work: (client: PoolClient) => Promise<T>): Promise<Result<T>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute(client, { scope, actorKey: actor.actorId, key, requestHash: hash(scope, payload), expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) }, async () => ({ statusCode, response: await work(client) }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }
}
