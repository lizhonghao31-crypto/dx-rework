import { createHash, randomUUID } from "node:crypto";

import type {
  CompletionConfirmationMutationResponse,
  CompletionIeReviewMutationResponse,
  CreateCompletionConfirmation,
  ReviewCompletionIe,
} from "@dx-rework/contracts/completion-review";
import type { Pool, PoolClient } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type OrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: string;
  version: number;
  style_no: string | null;
  order_no: string | null;
  merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: number | null;
}>;
type ProcessFactRow = Readonly<{
  configuration_item_id: string;
  process_name: string;
  unit_price: string | null;
  worker_reported_quantity: string;
  tail_checked_quantity: string;
}>;
type TemporaryWorkerRow = Readonly<{
  configuration_item_id: string;
  person_id: string;
}>;
type ConfirmationRow = Readonly<{
  completion_confirmation_id: string;
  confirmation_version: number;
  confirmed_by: string;
  confirmed_at: Date;
}>;
type ConfirmationItemRow = Readonly<{
  configuration_item_id: string;
  process_name: string;
  worker_reported_quantity: string;
  tail_checked_quantity: string;
  original_quantity: string;
  final_confirmed_quantity: string;
  modified_by: string | null;
  modified_at: Date | null;
}>;
type IeReviewRow = Readonly<{
  completion_ie_review_id: string;
  decision: "approved" | "rejected";
  reason: string | null;
  reviewed_by: string;
  reviewed_at: Date;
}>;

export type CompletionConfirmationSummary = Readonly<{
  confirmationId: string;
  confirmationVersion: number;
  confirmedBy: string;
  confirmedAt: string;
  processes: readonly Readonly<{
    configurationItemId: string;
    processName: string;
    workerReportedQuantity: number;
    tailCheckedQuantity: number;
    originalQuantity: number;
    finalConfirmedQuantity: number;
    modified: boolean;
    modifiedBy: string | null;
    modifiedAt: string | null;
  }>[];
  ieReview: Readonly<{
    ieReviewId: string;
    decision: "approved" | "rejected";
    reason: string | null;
    reviewedBy: string;
    reviewedAt: string;
  }> | null;
}>;

const error = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
const numberValue = (value: string | number): number => Number(value);
const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

export class CompletionReviewService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
  ) {}

  async available(client: Pick<Pool, "query"> | PoolClient = this.database): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('rework_final_completion_confirmations') IS NOT NULL AS available",
    );
    return result.rows[0]?.available === true;
  }

  canIeReview(actor: TrustedActorContext): boolean {
    return isRootActor(actor)
      || (actor.actorRoles.includes("ie_reviewer") && this.capabilities(actor).includes("process:review"));
  }

  async summary(reworkOrderId: string): Promise<CompletionConfirmationSummary | null> {
    if (!await this.available()) return null;
    const confirmation = await this.database.query<ConfirmationRow>(
      `SELECT completion_confirmation_id,confirmation_version,confirmed_by,confirmed_at
       FROM rework_final_completion_confirmations
       WHERE rework_order_id=$1
       ORDER BY confirmation_version DESC
       LIMIT 1`,
      [reworkOrderId],
    );
    const row = confirmation.rows[0];
    if (!row) return null;
    const [items, review] = await Promise.all([
      this.database.query<ConfirmationItemRow>(
        `SELECT item.configuration_item_id,process.process_name,item.worker_reported_quantity,
                item.tail_checked_quantity,item.original_quantity,item.final_confirmed_quantity,
                item.modified_by,item.modified_at
         FROM rework_final_completion_confirmation_items item
         JOIN rework_process_configuration_items process
           ON process.configuration_item_id=item.configuration_item_id
         WHERE item.completion_confirmation_id=$1
         ORDER BY process.position,process.configuration_item_id`,
        [row.completion_confirmation_id],
      ),
      this.database.query<IeReviewRow>(
        `SELECT completion_ie_review_id,decision,reason,reviewed_by,reviewed_at
         FROM rework_completion_ie_reviews
         WHERE completion_confirmation_id=$1`,
        [row.completion_confirmation_id],
      ),
    ]);
    const ie = review.rows[0];
    return {
      confirmationId: row.completion_confirmation_id,
      confirmationVersion: row.confirmation_version,
      confirmedBy: row.confirmed_by,
      confirmedAt: row.confirmed_at.toISOString(),
      processes: items.rows.map((item) => ({
        configurationItemId: item.configuration_item_id,
        processName: item.process_name,
        workerReportedQuantity: numberValue(item.worker_reported_quantity),
        tailCheckedQuantity: numberValue(item.tail_checked_quantity),
        originalQuantity: numberValue(item.original_quantity),
        finalConfirmedQuantity: numberValue(item.final_confirmed_quantity),
        modified: item.modified_by !== null,
        modifiedBy: item.modified_by,
        modifiedAt: item.modified_at?.toISOString() ?? null,
      })),
      ieReview: ie ? {
        ieReviewId: ie.completion_ie_review_id,
        decision: ie.decision,
        reason: ie.reason,
        reviewedBy: ie.reviewed_by,
        reviewedAt: ie.reviewed_at.toISOString(),
      } : null,
    };
  }

  async confirm(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: CreateCompletionConfirmation,
    key: string,
  ): Promise<Result<CompletionConfirmationMutationResponse>> {
    this.ensureTailConfirmation(actor);
    if (!await this.available()) error("PR-05 最终确认数据结构尚未部署", 409, "SCHEMA_NOT_READY");
    return this.mutate(actor, "rework.completion.confirm", key, { reworkOrderId, ...input }, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      this.ensureVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_order_review") {
        error("当前返工单不在尾部最终确认节点", 409, "INVALID_STATE_TRANSITION");
      }
      const processes = await this.processFacts(client, reworkOrderId);
      if (processes.length === 0) error("当前返工单没有可确认的返工工序", 409, "INVALID_STATE_TRANSITION");
      if (processes.some((item) => item.unit_price === null)) {
        error("所有工序必须完成 IE 核价后才能最终确认", 409, "INVALID_STATE_TRANSITION");
      }
      const submitted = new Map(input.finalQuantities.map((item) => [item.configurationItemId, item.finalConfirmedQuantity]));
      if (submitted.size !== processes.length || processes.some((item) => !submitted.has(item.configuration_item_id))) {
        error("最终确认数量必须完整覆盖每一道返工工序", 400, "VALIDATION_ERROR");
      }
      for (const process of processes) {
        const finalQuantity = submitted.get(process.configuration_item_id)!;
        const workerQuantity = numberValue(process.worker_reported_quantity);
        const tailQuantity = numberValue(process.tail_checked_quantity);
        if (workerQuantity <= 0 || tailQuantity <= 0 || finalQuantity > tailQuantity) {
          error(`${process.process_name} 的最终确认数量不能超过尾查数量`, 400, "VALIDATION_ERROR");
        }
      }
      const temporaryWorkers = await this.temporaryWorkers(client, reworkOrderId);
      const expectedCoefficientKeys = new Set(temporaryWorkers.map((item) => `${item.configuration_item_id}:${item.person_id}`));
      const submittedCoefficientKeys = new Set(input.temporaryCoefficients.map((item) => `${item.configurationItemId}:${item.personId}`));
      if (expectedCoefficientKeys.size !== submittedCoefficientKeys.size
        || [...expectedCoefficientKeys].some((value) => !submittedCoefficientKeys.has(value))) {
        error("每名临时工每道工序都必须保留一个实发系数；默认填 1.0", 400, "VALIDATION_ERROR");
      }
      const latest = await client.query<{ version: number }>(
        "SELECT COALESCE(max(confirmation_version),0)::int AS version FROM rework_final_completion_confirmations WHERE rework_order_id=$1",
        [reworkOrderId],
      );
      const confirmationId = randomUUID();
      const confirmationVersion = (latest.rows[0]?.version ?? 0) + 1;
      const eventId = await this.events.append(client, this.withCapability(actor, "submission:audit"), {
        action: "rework.completion.confirm",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: this.orderAudit(order),
        after: {
          ...this.orderAudit(order, "pending_completion_ie_review", order.version + 1),
          confirmationId,
          confirmationVersion,
          finalQuantities: input.finalQuantities,
          temporaryCoefficients: input.temporaryCoefficients,
        },
      });
      await this.context(client, eventId, actor.requestId, false);
      await client.query(
        `INSERT INTO rework_final_completion_confirmations(
           completion_confirmation_id,rework_order_id,confirmation_version,confirmed_by,
           operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [confirmationId, reworkOrderId, confirmationVersion, actor.actorId, eventId, actor.requestId],
      );
      for (const process of processes) {
        const workerQuantity = numberValue(process.worker_reported_quantity);
        const finalQuantity = submitted.get(process.configuration_item_id)!;
        const modified = finalQuantity !== workerQuantity;
        await client.query(
          `INSERT INTO rework_final_completion_confirmation_items(
             completion_confirmation_id,configuration_item_id,worker_reported_quantity,
             tail_checked_quantity,original_quantity,final_confirmed_quantity,modified_by,modified_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,CASE WHEN $7::uuid IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)`,
          [
            confirmationId, process.configuration_item_id, workerQuantity,
            numberValue(process.tail_checked_quantity), workerQuantity, finalQuantity,
            modified ? actor.actorId : null,
          ],
        );
      }
      for (const coefficient of input.temporaryCoefficients) {
        await client.query(
          `INSERT INTO rework_final_completion_coefficients(
             completion_confirmation_id,configuration_item_id,person_id,multiplier,reason
           ) VALUES($1,$2,$3,$4,$5)`,
          [confirmationId, coefficient.configurationItemId, coefficient.personId, coefficient.multiplier, coefficient.reason ?? null],
        );
      }
      await client.query(
        "UPDATE rework_orders SET status='pending_completion_ie_review',updated_by=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",
        [reworkOrderId, actor.actorId],
      );
      await this.outbox.enqueue(client, {
        topic: "rework.pending_completion_ie_review",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: order.rework_no, confirmationId, confirmationVersion },
        recipientKey: "role:ie_reviewer",
        idempotencyKey: `${reworkOrderId}:completion-ie-review:${confirmationVersion}`,
      });
      return {
        reworkOrderId,
        reworkStatus: "pending_completion_ie_review",
        orderVersion: order.version + 1,
        confirmationId,
        confirmationVersion,
      };
    });
  }

  async review(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: ReviewCompletionIe,
    key: string,
  ): Promise<Result<CompletionIeReviewMutationResponse>> {
    this.ensureIeReview(actor);
    if (!await this.available()) error("PR-05 最终确认数据结构尚未部署", 409, "SCHEMA_NOT_READY");
    const action = input.decision === "approved"
      ? "rework.completion_ie_review.approve"
      : "rework.completion_ie_review.reject";
    return this.mutate(actor, action, key, { reworkOrderId, ...input }, async (client) => {
      const order = await this.order(client, reworkOrderId, true);
      this.ensureVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_completion_ie_review") {
        error("当前返工单不在 IE 最终复核节点", 409, "INVALID_STATE_TRANSITION");
      }
      const confirmation = await client.query<ConfirmationRow>(
        `SELECT confirmation.completion_confirmation_id,confirmation.confirmation_version,
                confirmation.confirmed_by,confirmation.confirmed_at
         FROM rework_final_completion_confirmations confirmation
         LEFT JOIN rework_completion_ie_reviews review
           ON review.completion_confirmation_id=confirmation.completion_confirmation_id
         WHERE confirmation.rework_order_id=$1 AND review.completion_ie_review_id IS NULL
         ORDER BY confirmation.confirmation_version DESC
         LIMIT 1 FOR UPDATE OF confirmation`,
        [reworkOrderId],
      );
      const current = confirmation.rows[0];
      if (!current) error("没有待 IE 复核的尾部最终确认记录", 409, "INVALID_STATE_TRANSITION");
      const ieReviewId = randomUUID();
      const nextStatus = input.decision === "approved"
        ? "pending_responsibility_determination"
        : "pending_order_review";
      const eventId = await this.events.append(client, this.withCapability(actor, "process:review"), {
        action,
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: { ...this.orderAudit(order), confirmationId: current.completion_confirmation_id },
        after: {
          ...this.orderAudit(order, nextStatus, order.version + 1),
          confirmationId: current.completion_confirmation_id,
          ieReviewId,
          decision: input.decision,
        },
        ...(input.reason ? { reason: input.reason } : {}),
      });
      await this.context(client, eventId, actor.requestId, input.decision === "approved");
      await client.query(
        `INSERT INTO rework_completion_ie_reviews(
           completion_ie_review_id,completion_confirmation_id,rework_order_id,decision,reason,
           reviewed_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [
          ieReviewId, current.completion_confirmation_id, reworkOrderId, input.decision,
          input.reason ?? null, actor.actorId, eventId, actor.requestId,
        ],
      );
      if (input.decision === "rejected") {
        await client.query(
          "UPDATE rework_orders SET status='pending_order_review',updated_by=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",
          [reworkOrderId, actor.actorId],
        );
        await this.outbox.enqueue(client, {
          topic: "rework.completion_ie_review.rejected",
          aggregateType: "rework_order",
          aggregateId: reworkOrderId,
          payload: { reworkOrderId, reworkNo: order.rework_no, confirmationId: current.completion_confirmation_id, ieReviewId },
          recipientKey: "role:tail_supervisor",
          idempotencyKey: `${reworkOrderId}:completion-ie-rejected:${ieReviewId}`,
        });
      } else {
        await this.applyFinalWages(client, current.completion_confirmation_id, reworkOrderId);
        const items = await client.query<ConfirmationItemRow>(
          `SELECT item.configuration_item_id,process.process_name,item.worker_reported_quantity,
                  item.tail_checked_quantity,item.original_quantity,item.final_confirmed_quantity,
                  item.modified_by,item.modified_at
           FROM rework_final_completion_confirmation_items item
           JOIN rework_process_configuration_items process
             ON process.configuration_item_id=item.configuration_item_id
           WHERE item.completion_confirmation_id=$1
           ORDER BY process.position,process.configuration_item_id`,
          [current.completion_confirmation_id],
        );
        const reportSnapshot = await client.query<{
          work_report_id: string;
          configuration_item_id: string;
          actual_quantity: string;
          group_amount: string;
          completed_at: Date;
          submitted_by: string;
        }>(
          `SELECT report.work_report_id,report.configuration_item_id,report.actual_quantity,
                  report.group_amount,report.completed_at,report.submitted_by
           FROM rework_work_reports report
           WHERE report.rework_order_id=$1 AND report.status='submitted'
             AND NOT EXISTS(
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
           ORDER BY report.completed_at,report.work_report_id`,
          [reworkOrderId],
        );
        const orderReviewId = randomUUID();
        const snapshot = {
          completionConfirmationId: current.completion_confirmation_id,
          confirmationVersion: current.confirmation_version,
          ieReviewId,
          decision: "approved",
          processes: items.rows.map((item) => ({
            configurationItemId: item.configuration_item_id,
            processName: item.process_name,
            workerReportedQuantity: numberValue(item.worker_reported_quantity),
            tailCheckedQuantity: numberValue(item.tail_checked_quantity),
            originalQuantity: numberValue(item.original_quantity),
            finalConfirmedQuantity: numberValue(item.final_confirmed_quantity),
            modifiedBy: item.modified_by,
            modifiedAt: item.modified_at?.toISOString() ?? null,
          })),
          reports: reportSnapshot.rows.map((report) => ({
            workReportId: report.work_report_id,
            configurationItemId: report.configuration_item_id,
            actualQuantity: numberValue(report.actual_quantity),
            groupAmount: numberValue(report.group_amount),
            completedAt: report.completed_at.toISOString(),
            submittedBy: report.submitted_by,
          })),
        };
        await client.query(
          "INSERT INTO rework_order_reviews(order_review_id,rework_order_id,reviewed_by,review_snapshot) VALUES($1,$2,$3,$4)",
          [orderReviewId, reworkOrderId, actor.actorId, snapshot],
        );
        await client.query(
          "UPDATE rework_orders SET status='pending_responsibility_determination',updated_by=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE rework_order_id=$1",
          [reworkOrderId, actor.actorId],
        );
        await this.outbox.enqueue(client, {
          topic: "rework.pending_responsibility_determination",
          aggregateType: "rework_order",
          aggregateId: reworkOrderId,
          payload: { reworkOrderId, reworkNo: order.rework_no, orderReviewId, confirmationId: current.completion_confirmation_id, ieReviewId },
          recipientKey: "role:production_management",
          idempotencyKey: `${reworkOrderId}:completion-ie-approved:${ieReviewId}`,
        });
      }
      return {
        reworkOrderId,
        reworkStatus: nextStatus,
        orderVersion: order.version + 1,
        confirmationId: current.completion_confirmation_id,
        ieReviewId,
        decision: input.decision,
      };
    });
  }

  private capabilities(actor: TrustedActorContext): readonly string[] {
    return actor.authorizationCapabilities ?? [actor.authorizationCapability];
  }

  private ensureTailConfirmation(actor: TrustedActorContext): void {
    if (isRootActor(actor)) return;
    if (!actor.actorRoles.includes("tail_supervisor") || !this.capabilities(actor).includes("submission:audit")) {
      error("只有尾部主管可以确认最终生产数量", 403, "FORBIDDEN");
    }
  }

  private ensureIeReview(actor: TrustedActorContext): void {
    if (!this.canIeReview(actor)) error("只有 IE 可以复核最终数量与质量", 403, "FORBIDDEN");
  }

  private withCapability(actor: TrustedActorContext, capability: string): TrustedActorContext {
    return { ...actor, authorizationCapability: capability };
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    action: string,
    key: string,
    payload: unknown,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<Result<T>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const executed = await this.idempotency.execute(client, {
        scope: action,
        actorKey: actor.actorId,
        key,
        requestHash: hash(action, payload),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode: 200, response: await work(client) }));
      await client.query("COMMIT");
      return { value: executed.response, reused: executed.reused };
    } catch (cause) {
      await client.query("ROLLBACK");
      throw cause;
    } finally {
      client.release();
    }
  }

  private async order(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, lock: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,
              processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,
              problem_part,problem_description,rework_quantity
       FROM rework_orders WHERE rework_order_id=$1${lock ? " FOR UPDATE" : ""}`,
      [reworkOrderId],
    );
    return result.rows[0] ?? error("返工单不存在", 404, "NOT_FOUND");
  }

  private ensureVersion(order: OrderRow, expected: number): void {
    if (order.version !== expected) error("返工单已被其他人更新，请刷新后重试", 409, "VERSION_CONFLICT");
  }

  private orderAudit(order: OrderRow, status = order.status, version = order.version) {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null
        ? null
        : order.processing_factory_type === "own_factory"
          ? { type: "own_factory" }
          : {
              type: "supplier",
              supplierId: order.processing_factory_supplier_id,
              supplierVersion: order.processing_factory_supplier_version,
            },
      problemPart: order.problem_part,
      problemDescription: order.problem_description,
      reworkQuantity: order.rework_quantity,
      version,
    };
  }

  private async context(client: PoolClient, eventId: string, requestId: string, wholeOrderReview: boolean): Promise<void> {
    await client.query(
      `SELECT set_config('dx_rework.rework_event_id',$1,true),
              set_config('dx_rework.rework_request_id',$2,true),
              set_config('dx_rework.whole_order_review_event_id',$3,true),
              set_config('dx_rework.whole_order_review_request_id',$4,true)`,
      [eventId, requestId, wholeOrderReview ? eventId : "", wholeOrderReview ? requestId : ""],
    );
  }

  private async processFacts(client: PoolClient, reworkOrderId: string): Promise<ProcessFactRow[]> {
    const result = await client.query<ProcessFactRow>(
      `WITH tail_total AS (
         SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
         FROM rework_work_reports report
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=report.configuration_item_id
         WHERE report.rework_order_id=$1
           AND item.execution_kind='tail_inspection'
           AND report.status='submitted'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_report_rejections rejection
             WHERE rejection.work_report_id=report.work_report_id
           )
       )
       SELECT item.configuration_item_id,item.process_name,item.unit_price,
              COALESCE(sum(report.actual_quantity) FILTER(
                WHERE report.status='submitted' AND rejection.work_report_id IS NULL
              ),0) AS worker_reported_quantity,
              tail_total.quantity AS tail_checked_quantity
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item
         ON item.configuration_id=configuration.configuration_id
        AND item.execution_kind='worker'
       CROSS JOIN tail_total
       LEFT JOIN rework_work_reports report
         ON report.rework_order_id=configuration.rework_order_id
        AND report.configuration_item_id=item.configuration_item_id
       LEFT JOIN rework_work_report_rejections rejection
         ON rejection.work_report_id=report.work_report_id
       WHERE configuration.rework_order_id=$1 AND configuration.status='approved'
       GROUP BY item.configuration_item_id,item.position,item.process_name,item.unit_price,tail_total.quantity
       ORDER BY item.position,item.configuration_item_id`,
      [reworkOrderId],
    );
    return result.rows;
  }

  private async temporaryWorkers(client: PoolClient, reworkOrderId: string): Promise<TemporaryWorkerRow[]> {
    const result = await client.query<TemporaryWorkerRow>(
      `SELECT DISTINCT task.configuration_item_id,member.person_id
       FROM rework_work_tasks task
       JOIN rework_process_configuration_items item
         ON item.configuration_item_id=task.configuration_item_id
        AND item.execution_kind='worker'
       JOIN rework_work_task_members member
         ON member.work_task_id=task.work_task_id
        AND member.person_type_snapshot='temporary'
       WHERE task.rework_order_id=$1 AND task.status='active'
       ORDER BY task.configuration_item_id,member.person_id`,
      [reworkOrderId],
    );
    return result.rows;
  }

  private async applyFinalWages(client: PoolClient, confirmationId: string, reworkOrderId: string): Promise<void> {
    await client.query(
      `WITH report_totals AS (
         SELECT report.configuration_item_id,sum(report.actual_quantity) AS quantity
         FROM rework_work_reports report
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=report.configuration_item_id
          AND item.execution_kind='worker'
         WHERE report.rework_order_id=$2 AND report.status='submitted'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_report_rejections rejection
             WHERE rejection.work_report_id=report.work_report_id
           )
         GROUP BY report.configuration_item_id
       ), share_counts AS (
         SELECT share.work_report_id,count(*)::numeric AS member_count
         FROM rework_work_report_member_shares share
         GROUP BY share.work_report_id
       ), amounts AS (
         SELECT share.work_report_id,share.person_id,
                round(
                  final.final_confirmed_quantity*process.unit_price*
                  report.actual_quantity/NULLIF(total.quantity,0)*
                  CASE WHEN task.assignment_mode='collective'
                    THEN 1/share_counts.member_count ELSE 1 END *
                  CASE WHEN member.person_type_snapshot='temporary'
                    THEN COALESCE(coefficient.multiplier,1) ELSE 1 END,
                  8
                ) AS amount
         FROM rework_work_report_member_shares share
         JOIN rework_work_reports report ON report.work_report_id=share.work_report_id
         JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
         JOIN rework_work_task_members member
           ON member.work_task_id=task.work_task_id AND member.person_id=share.person_id
         JOIN rework_process_configuration_items process
           ON process.configuration_item_id=report.configuration_item_id
          AND process.execution_kind='worker'
         JOIN rework_final_completion_confirmation_items final
           ON final.completion_confirmation_id=$1
          AND final.configuration_item_id=report.configuration_item_id
         JOIN report_totals total ON total.configuration_item_id=report.configuration_item_id
         JOIN share_counts ON share_counts.work_report_id=report.work_report_id
         LEFT JOIN rework_final_completion_coefficients coefficient
           ON coefficient.completion_confirmation_id=$1
          AND coefficient.configuration_item_id=report.configuration_item_id
          AND coefficient.person_id=share.person_id
         WHERE report.rework_order_id=$2 AND report.status='submitted'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_report_rejections rejection
             WHERE rejection.work_report_id=report.work_report_id
           )
       )
       UPDATE rework_work_report_member_shares share SET amount=amounts.amount
       FROM amounts
       WHERE share.work_report_id=amounts.work_report_id AND share.person_id=amounts.person_id`,
      [confirmationId, reworkOrderId],
    );
    await client.query(
      `WITH totals AS (
         SELECT report.work_report_id,sum(share.amount) AS amount
         FROM rework_work_reports report
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=report.configuration_item_id
          AND item.execution_kind='worker'
         JOIN rework_work_report_member_shares share ON share.work_report_id=report.work_report_id
         WHERE report.rework_order_id=$1 AND report.status='submitted'
           AND NOT EXISTS(
             SELECT 1 FROM rework_work_report_rejections rejection
             WHERE rejection.work_report_id=report.work_report_id
           )
         GROUP BY report.work_report_id
       )
       UPDATE rework_work_reports report SET group_amount=totals.amount
       FROM totals WHERE report.work_report_id=totals.work_report_id`,
      [reworkOrderId],
    );
  }
}
