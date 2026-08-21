import { createHash, randomUUID } from "node:crypto";

import type {
  ConfirmQuantityIncrease,
  CreateQuantityDecrease,
  CreateQuantityIncrease,
  QuantityAdjustmentResponse,
  RejectWorkReport,
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
  problem_description: string | null; rework_quantity: number | null;
}>;
type PlanRow = Readonly<{
  configuration_item_id: string; process_name: string; pricing_unit: "piece" | "hour";
  planned_quantity: string; completed_quantity: string; tail_checked_quantity: string; unit_price: string | null;
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
      const canReview = await this.can(actor, "tail_supervisor", "submission:audit", order, configurationItemId);
      if (!canReview) error("当前用户无权读取整单确认信息", 403, "FORBIDDEN");
      return this.dto(this.database, order, { canReview, canAdjustQuantity: false, canConfirmQuantity: false, canReviewQuantityIncrease: false }, configurationItemId);
    }
    const canReview = await this.canOrderWide(actor, "tail_supervisor", "submission:audit", order);
    if (!canReview) error("当前用户无权读取整单确认信息", 403, "FORBIDDEN");
    return this.dto(this.database, order, { canReview, canAdjustQuantity: false, canConfirmQuantity: false, canReviewQuantityIncrease: false });
  }

  async approve(actor: TrustedActorContext, reworkOrderId: string, input: ReviewWholeOrder, key: string): Promise<Result<WholeOrderReviewResponse>> {
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
      await this.assertTailReconciliation(client, reworkOrderId);
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
            "Newly materialized wage facts require a fresh month-close task",
          );
          await this.todos.actionableForUniqueDirectRole(client, actor, {
            category: "wage_month_close",
            sourceEventId: eventId,
            sourceAction: "rework.whole_order.approve",
            entityType: "rework_order",
            entityId: reworkOrderId,
            requiredRole: "wage_month_close_accountant",
            requiredCapability: "wage:month_close",
            route: {
              routeName: "wage_period_detail",
              entityId: wagePeriod.period_id,
            },
            policyKey: "finance_return_or_wage_review",
            dedupeKey: `wage-month-lock:${wagePeriod.period_id}:${wagePeriod.period_version}`,
          });
        }
      }
      await this.outbox.enqueue(client, {
        topic: "rework.pending_responsibility_determination", aggregateType: "rework_order", aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: order.rework_no, orderReviewId: reviewId }, recipientKey: "role:production_management",
        idempotencyKey: reworkOrderId + ":whole-order-review:" + reviewId,
      });
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
    permissions: Readonly<{ canReview: boolean; canAdjustQuantity: boolean; canConfirmQuantity: boolean; canReviewQuantityIncrease: boolean }>,
    configurationItemId?: string,
  ): Promise<WholeOrderReviewResponse> {
    const plans = await this.plans(client, order.rework_order_id);
    const [reports, reviews, temporaryWorkers, unifiedExecutionRequired] = await Promise.all([
      this.reports(client, order.rework_order_id, configurationItemId),
      configurationItemId
        ? Promise.resolve({ rows: [] as Array<{ order_review_id: string }> })
        : client.query<{ order_review_id: string }>("SELECT order_review_id FROM rework_order_reviews WHERE rework_order_id=$1", [order.rework_order_id]),
      this.temporaryWorkers(client, order.rework_order_id, configurationItemId),
      this.unifiedExecutionRequired(client, order.rework_order_id),
    ]);
    return {
      reworkOrderId: order.rework_order_id, reworkStatus: order.status as WholeOrderReviewResponse["reworkStatus"], orderVersion: order.version,
      ...permissions, unifiedExecutionRequired,
      processes: plans.filter((plan) => !configurationItemId || plan.configuration_item_id === configurationItemId).map((plan) => ({ configurationItemId: plan.configuration_item_id, processName: plan.process_name, pricingUnit: plan.pricing_unit, plannedQuantity: numberValue(plan.planned_quantity), completedQuantity: numberValue(plan.completed_quantity), tailCheckedQuantity: numberValue(plan.tail_checked_quantity), countGap: numberValue(plan.tail_checked_quantity) - numberValue(plan.completed_quantity), complete: numberValue(plan.completed_quantity) <= numberValue(plan.tail_checked_quantity), finalUnitPrice: plan.unit_price === null ? null : numberValue(plan.unit_price) })),
      reports,
      adjustments: [],
      temporaryWorkers: temporaryWorkers.map((worker) => ({ configurationItemId: worker.configuration_item_id, processName: worker.process_name, personId: worker.person_id, displayName: worker.display_name, multiplier: numberValue(worker.multiplier ?? "1"), reason: worker.reason })),
      reviewId: reviews.rows[0]?.order_review_id ?? null,
    };
  }

  private async snapshot(client: PoolClient, order: OrderRow, plans: readonly PlanRow[]): Promise<Record<string, unknown>> {
    return {
      order: this.orderAudit(order),
      processes: plans.map((plan) => ({ configurationItemId: plan.configuration_item_id, processName: plan.process_name, pricingUnit: plan.pricing_unit, workerReportedQuantity: numberValue(plan.completed_quantity), tailCheckedQuantity: numberValue(plan.tail_checked_quantity) })),
      reports: await this.reports(client, order.rework_order_id),
    };
  }

  private async plans(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string): Promise<PlanRow[]> {
    const result = await client.query<PlanRow>(
      `SELECT item.configuration_item_id,item.process_name,item.pricing_unit,item.unit_price,
              item.planned_quantity::text AS planned_quantity,
              COALESCE(completed.quantity,0)::text AS completed_quantity,
              COALESCE(CASE WHEN configuration.unified_execution_required
                THEN unified_tail.quantity ELSE legacy_tail.quantity END,0)::text AS tail_checked_quantity
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
       LEFT JOIN LATERAL (
         SELECT sum(report.actual_quantity) AS quantity FROM rework_work_reports report
         WHERE report.rework_order_id=$1 AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
           AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       ) completed ON true
       LEFT JOIN LATERAL (
         SELECT sum(report.actual_quantity) AS quantity
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
      [reworkOrderId],
    );
    return result.rows;
  }

  private async assertTailReconciliation(client: PoolClient, reworkOrderId: string): Promise<void> {
    const pending = await client.query<{ issue: string }>(
      `WITH active_configuration AS (
         SELECT configuration_id,unified_execution_required
         FROM rework_process_configurations
         WHERE rework_order_id=$1 AND status='approved'
         LIMIT 1
       ), unified_tail AS (
         SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
         FROM rework_work_reports report
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=report.configuration_item_id
          AND item.execution_kind='tail_inspection'
         WHERE report.rework_order_id=$1 AND report.status='submitted'
           AND NOT EXISTS (SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       )
       SELECT 'execution'::text AS issue
       WHERE EXISTS(
         SELECT 1 FROM rework_work_tasks task
         WHERE task.rework_order_id=$1 AND task.status='active'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_reports report
             WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
               AND NOT EXISTS(
                 SELECT 1 FROM rework_work_report_rejections rejection
                 WHERE rejection.work_report_id=report.work_report_id
               )
           )
       )
       UNION ALL
       SELECT 'legacy_tail'::text AS issue
       WHERE COALESCE((SELECT unified_execution_required FROM active_configuration),false)=false
         AND EXISTS(
           SELECT 1 FROM rework_tail_inspection_assignments assignment
           WHERE assignment.rework_order_id=$1 AND assignment.revoked_at IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM rework_tail_inspection_reports report
               WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
                 AND report.status='submitted'
             )
         )
       UNION ALL
       SELECT item.process_name
       FROM active_configuration active
       JOIN rework_process_configuration_items item ON item.configuration_id=active.configuration_id
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
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
         AND worker.quantity > CASE WHEN active.unified_execution_required THEN unified_tail.quantity ELSE legacy_tail.quantity END`,
      [reworkOrderId],
    );
    const issues = pending.rows.map((row) => row.issue);
    if (issues.includes("execution")) error("仍有返工执行报数未完成，不能整单确认", 409, "CONFLICT");
    if (issues.includes("legacy_tail")) error("历史订单仍有尾查报数未完成，不能整单确认", 409, "CONFLICT");
    const processIssues = issues.filter((issue) => issue !== "execution" && issue !== "legacy_tail");
    if (processIssues.length > 0) error(`返工上数超过尾查数量：${processIssues.join("、")}；请驳回并调整报数`, 409, "CONFLICT");
  }

  private async reports(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, configurationItemId?: string): Promise<WholeOrderReviewResponse["reports"]> {
    const [reports, members] = await Promise.all([
      client.query<ReportRow>(
        `SELECT report.work_report_id,report.work_task_id,report.configuration_item_id,report.actual_quantity,
                report.completed_at,report.submitted_by,report.resubmits_work_report_id,
                task.assignment_mode,item.execution_kind,rejection.report_rejection_id,rejection.rejected_person_id,rejection.reason AS rejection_reason
         FROM rework_work_reports report
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         JOIN rework_process_configuration_items item ON item.configuration_item_id=task.configuration_item_id
         LEFT JOIN rework_work_report_rejections rejection ON rejection.work_report_id=report.work_report_id
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
      actualQuantity: numberValue(report.actual_quantity), completedAt: report.completed_at.toISOString(), submittedBy: report.submitted_by,
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
    if (item.execution_kind === "tail_inspection") error("尾查工序使用实际报数，不参与计划数量调整", 409, "INVALID_STATE_TRANSITION");
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
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,problem_part,problem_description,rework_quantity FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted'${locked ? " FOR UPDATE" : ""}`,
      [reworkOrderId],
    );
    return result.rows[0] ?? error("返工单不存在", 404, "NOT_FOUND");
  }

  private async context(client: PoolClient, eventId: string, requestId: string, kind: "whole_order_review" | "quantity_adjustment"): Promise<void> {
    const whole = kind === "whole_order_review" ? eventId : "";
    const quantity = kind === "quantity_adjustment" ? eventId : "";
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true),set_config('dx_rework.whole_order_review_event_id',$3,true),set_config('dx_rework.whole_order_review_request_id',$2,true),set_config('dx_rework.quantity_adjustment_event_id',$4,true),set_config('dx_rework.quantity_adjustment_request_id',$2,true)",
      [eventId, requestId, whole, quantity],
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
