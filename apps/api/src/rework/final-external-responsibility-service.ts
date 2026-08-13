import { createHash, randomUUID } from "node:crypto";

import type {
  DecideExternalResponsibilityRevision,
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import type { TodoRouteTemplate } from "../todos/service.js";
import { FixedExternalResponsibilityService } from "./fixed-external-responsibility-service.js";

type Result<T> = { value: T; reused: boolean };
type OrderRow = {
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
};
type RevisionRow = {
  revision_request_id: string;
  case_id: string;
  source_case_status:
    | "pending_business_signoff"
    | "returned"
    | "pending_payables_confirmation"
    | "deduction_follow_up"
    | "closed";
  finalized_determination_id: string;
  finalized_determination_version: number;
  revision_version: number;
  status: "pending" | "approved" | "rejected";
  reason: string;
};
type CaseRow = {
  case_id: string;
  batch_id: string;
  rework_order_id: string;
  case_version: number;
  status: string;
};

const fail = (
  message: string,
  status = 409,
  code = "CONFLICT",
): never => {
  throw new ApplicationError(code, message, status);
};

const orderAudit = (
  order: OrderRow,
  status = order.status,
  version = order.version,
): Record<string, unknown> => ({
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
});

/**
 * Final PR-11 service after review closure.
 *
 * All ordinary N08-B/N10-B methods are inherited. Their internal `this.get()`
 * and `this.getCase()` calls dynamically use the corrected reads below. Only
 * revision approval is replaced because it must reopen N07 and seed its draft
 * in the same idempotent transaction.
 */
export class FinalExternalResponsibilityService
  extends FixedExternalResponsibilityService {
  private readonly reviewIdempotency = new IdempotencyService();
  private readonly reviewEvents = new OperationEventRepository();

  constructor(
    private readonly finalDatabase: Pool,
    private readonly finalTodos?: TodoProjectionService,
  ) {
    super(finalDatabase, finalTodos);
  }

  override async get(
    actor: TrustedActorContext,
    orderId: string,
    executor: Pool | PoolClient = this.finalDatabase,
  ): Promise<ExternalResponsibilityBatchResponse> {
    const value = await super.get(actor, orderId, executor);
    if (!value) return null;
    return {
      ...value,
      cases: await Promise.all(
        value.cases.map((item) => this.enrichCase(item, executor)),
      ),
    };
  }

  override async getCase(
    actor: TrustedActorContext,
    caseId: string,
    executor: Pool | PoolClient = this.finalDatabase,
  ): Promise<ExternalResponsibilityCaseResponse> {
    const baseValue = await super.getCase(actor, caseId, executor);
    return this.enrichCase(
      baseValue as ExternalResponsibilityCaseResponse,
      executor,
    );
  }

  approveRevision(
    actor: TrustedActorContext,
    requestId: string,
    input: DecideExternalResponsibilityRevision,
    key: string,
  ): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.decideReviewedRevision(
      actor,
      requestId,
      input,
      "approved",
      key,
    );
  }

  rejectRevision(
    actor: TrustedActorContext,
    requestId: string,
    input: DecideExternalResponsibilityRevision,
    key: string,
  ): Promise<Result<ExternalResponsibilityCaseResponse>> {
    return this.decideReviewedRevision(
      actor,
      requestId,
      input,
      "rejected",
      key,
    );
  }

  private async decideReviewedRevision(
    actor: TrustedActorContext,
    requestId: string,
    input: DecideExternalResponsibilityRevision,
    decision: "approved" | "rejected",
    key: string,
  ): Promise<Result<ExternalResponsibilityCaseResponse>> {
    const client = await this.finalDatabase.connect();
    try {
      await client.query("BEGIN");
      const scope = `rework.external_responsibility.revision.${decision}`;
      const result = await this.reviewIdempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify({ requestId, input, decision }))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 200,
        response: await this.performRevisionDecision(
          client,
          actor,
          requestId,
          input,
          decision,
        ),
      }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async performRevisionDecision(
    client: PoolClient,
    actor: TrustedActorContext,
    requestId: string,
    input: DecideExternalResponsibilityRevision,
    decision: "approved" | "rejected",
  ): Promise<ExternalResponsibilityCaseResponse> {
    const revisionResult = await client.query<RevisionRow>(
      `SELECT revision_request_id,case_id,source_case_status,
              finalized_determination_id,finalized_determination_version,
              revision_version,status,reason
       FROM rework_external_responsibility_revision_requests
       WHERE revision_request_id=$1
       FOR UPDATE`,
      [requestId],
    );
    const revision = revisionResult.rows[0]
      ?? fail("责任变更申请不存在", 404, "NOT_FOUND");
    const caseResult = await client.query<CaseRow>(
      `SELECT target_case.case_id,target_case.batch_id,
              target_case.rework_order_id,target_case.case_version,
              target_case.status
       FROM rework_external_responsibility_cases target_case
       JOIN rework_external_responsibility_batches batch
         ON batch.batch_id=target_case.batch_id
       WHERE target_case.case_id=$1 AND batch.status='active'
       FOR UPDATE OF target_case,batch`,
      [revision.case_id],
    );
    const targetCase = caseResult.rows[0]
      ?? fail("责任版本已被替代", 409, "INVALID_STATE_TRANSITION");
    if (
      revision.status !== "pending"
      || revision.revision_version !== input.expectedRevisionVersion
      || targetCase.case_version !== input.expectedCaseVersion
      || targetCase.status !== "pending_responsibility_revision"
    ) {
      fail("责任变更申请版本冲突");
    }
    const permission = await client.query<{ permitted: boolean }>(
      `SELECT external_responsibility_direct_role(
         $1,'external_responsibility:approve_revision',
         ARRAY['production_management','owner_group']
       ) permitted`,
      [actor.actorId],
    );
    if (!permission.rows[0]?.permitted) {
      fail("当前用户无权审核责任变更", 403, "FORBIDDEN");
    }
    const orderResult = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,
              processing_factory_supplier_version,problem_part,
              problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'
       FOR UPDATE`,
      [targetCase.rework_order_id],
    );
    const order = orderResult.rows[0]
      ?? fail("返工单不存在", 404, "NOT_FOUND");
    const action = `rework.external_responsibility.revision.${decision}`;
    const nextStatus = decision === "approved"
      ? "pending_responsibility_determination"
      : order.status;
    const nextVersion = decision === "approved"
      ? order.version + 1
      : order.version;
    const externalEventId = await this.reviewEvents.append(
      client,
      {
        ...actor,
        authorizationCapability: "external_responsibility:approve_revision",
      },
      {
        action,
        entityType: "rework_order",
        entityId: order.rework_order_id,
        before: orderAudit(order),
        after: orderAudit(order, nextStatus, nextVersion),
        reason: input.reason ?? revision.reason,
      },
    );
    await client.query(
      `SELECT
         set_config('dx_rework.external_responsibility_event_id',$1,true),
         set_config('dx_rework.external_responsibility_request_id',$2,true)`,
      [externalEventId, actor.requestId],
    );

    let seededDeterminationId: string | null = null;
    if (decision === "approved") {
      if (
        !(actor.authorizationCapabilities ?? [])
          .includes("responsibility:determine")
      ) {
        fail(
          "审核人缺少责任判定能力，不能生成 N07 草稿",
          403,
          "FORBIDDEN",
        );
      }
      await client.query(
        `SELECT
           set_config('dx_rework.rework_event_id',$1,true),
           set_config('dx_rework.rework_request_id',$2,true)`,
        [externalEventId, actor.requestId],
      );
      const supersededCases = await client.query<{ case_id: string }>(
        `SELECT case_id
         FROM rework_external_responsibility_cases
         WHERE batch_id=$1 AND status<>'closed'
         ORDER BY case_id
         FOR UPDATE`,
        [targetCase.batch_id],
      );
      await client.query(
        `UPDATE rework_external_responsibility_cases
         SET status='superseded',case_version=case_version+1
         WHERE batch_id=$1 AND status<>'closed'`,
        [targetCase.batch_id],
      );
      await client.query(
        `UPDATE rework_external_responsibility_batches
         SET status='superseded',batch_version=batch_version+1
         WHERE batch_id=$1`,
        [targetCase.batch_id],
      );
      for (const supersededCase of supersededCases.rows) {
        for (const prefix of [
          `external-signoff:${supersededCase.case_id}:`,
          `external-payables:${supersededCase.case_id}:`,
          `external-return:${supersededCase.case_id}:`,
          `deduction-follow-up:${supersededCase.case_id}:`,
          `deduction-overdue:${supersededCase.case_id}:`,
          `external-deduction:${supersededCase.case_id}:`,
        ]) {
          await this.finalTodos?.cancelOpenByDedupePrefix(
            client,
            actor,
            prefix,
            "External responsibility revision superseded the active case",
          );
        }
      }
      await client.query(
        `UPDATE rework_orders
         SET status='pending_responsibility_determination',
             version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [order.rework_order_id, actor.actorId],
      );
      seededDeterminationId = await this.seedDraft(
        client,
        actor,
        revision,
        {
          ...order,
          status: "pending_responsibility_determination",
          version: order.version + 1,
        },
      );
    } else {
      await client.query(
        `UPDATE rework_external_responsibility_cases
         SET status=$2,case_version=case_version+1
         WHERE case_id=$1`,
        [targetCase.case_id, revision.source_case_status],
      );
      const pausedTodos = await client.query<{
        category: string;
        recipient_user_id: string;
        required_role: string;
        required_capability: string;
        delegation_id: string | null;
        delegation_scope_id: string | null;
        route_descriptor: TodoRouteTemplate;
        policy_key: "general" | "finance_return_or_wage_review" | "deduction_follow_up";
        due_at: Date | null;
        dedupe_key: string;
      }>(
        `SELECT category,recipient_user_id,required_role,required_capability,
                delegation_id,delegation_scope_id,route_descriptor,policy_key,
                due_at,dedupe_key
         FROM rework_todos
         WHERE todo_type='business_action'
           AND status='cancelled'
           AND cancelled_reason=$1
         ORDER BY todo_id`,
        [`External responsibility revision ${requestId} paused the prior action`],
      );
      const routingManagers = await client.query<{ user_id: string }>(
        `SELECT DISTINCT assignment.user_id
         FROM user_role_assignments assignment
         WHERE assignment.role_code='production_management'
           AND assignment.revoked_at IS NULL
           AND todo_user_has_direct_role(
             assignment.user_id,'production_management','todo:routing_exception_manage'
           )
         ORDER BY assignment.user_id
         LIMIT 2`,
      );
      const routingManager = routingManagers.rows.length === 1
        ? routingManagers.rows[0]!.user_id
        : null;
      for (const paused of pausedTodos.rows) {
        await this.finalTodos?.actionableForRecipient(client, actor, {
          category: paused.category,
          sourceEventId: externalEventId,
          sourceAction: action,
          entityType: "rework_order",
          entityId: order.rework_order_id,
          recipientUserId: paused.recipient_user_id,
          requiredRole: paused.required_role,
          requiredCapability: paused.required_capability,
          ...(paused.delegation_id ? { delegationId: paused.delegation_id } : {}),
          ...(paused.delegation_scope_id
            ? { delegationScopeId: paused.delegation_scope_id }
            : {}),
          route: paused.route_descriptor,
          policyKey: paused.policy_key,
          ...(paused.policy_key === "deduction_follow_up" && paused.due_at
            ? { authoritativeDueAt: paused.due_at }
            : {}),
          dedupeKey:
            `${paused.dedupe_key}:revision-rejected:${requestId}:${revision.revision_version + 1}`,
          ...(routingManager ? {
            invalidRecipientRouting: {
              reason: "recipient_no_longer_directly_eligible",
              assignedToUserId: routingManager,
            },
          } : {}),
        });
      }
    }

    await client.query(
      `UPDATE rework_external_responsibility_revision_requests
       SET status=$2,revision_version=revision_version+1,
           decided_by=$3,decision_reason=$4,
           decision_operation_event_id=$5,decision_request_id=$6,
           seeded_determination_id=$7,decided_at=CURRENT_TIMESTAMP
       WHERE revision_request_id=$1`,
      [
        requestId,
        decision,
        actor.actorId,
        input.reason ?? null,
        externalEventId,
        actor.requestId,
        seededDeterminationId,
      ],
    );

    return this.getCase(actor, targetCase.case_id, client);
  }

  private async seedDraft(
    client: PoolClient,
    actor: TrustedActorContext,
    revision: RevisionRow,
    reopenedOrder: OrderRow,
  ): Promise<string> {
    const draftEventId = await this.reviewEvents.append(
      client,
      { ...actor, authorizationCapability: "responsibility:determine" },
      {
        action: "rework.responsibility.draft",
        entityType: "rework_order",
        entityId: reopenedOrder.rework_order_id,
        before: orderAudit(reopenedOrder),
        after: orderAudit(
          reopenedOrder,
          reopenedOrder.status,
          reopenedOrder.version + 1,
        ),
        reason:
          `外部责任变更申请 ${revision.revision_request_id} 已批准：${revision.reason}`,
      },
    );
    await client.query(
      `SELECT
         set_config('dx_rework.responsibility_event_id',$1,true),
         set_config('dx_rework.responsibility_request_id',$2,true),
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true)`,
      [draftEventId, actor.requestId],
    );
    const draftId = randomUUID();
    await client.query(
      `INSERT INTO rework_responsibility_determinations(
         determination_id,rework_order_id,determination_version,
         replaces_determination_id,source_order_review_id,stage,
         handler_user_id,created_by,reason,input_snapshot,
         calculation_total,operation_event_id,request_id,settlement_schema_version
       )
       SELECT $1,rework_order_id,determination_version+1,
              determination_id,source_order_review_id,'draft',$2,$2,$3,
              input_snapshot,calculation_total,$4,$5,settlement_schema_version
       FROM rework_responsibility_determinations
       WHERE determination_id=$6 AND stage='finalized'`,
      [
        draftId,
        actor.actorId,
        `外部责任变更申请 ${revision.revision_request_id} 已批准：${revision.reason}`,
        draftEventId,
        actor.requestId,
        revision.finalized_determination_id,
      ],
    );
    await client.query(
      `INSERT INTO rework_responsibility_processes
       SELECT $1,configuration_item_id,process_name_snapshot,
              pricing_unit_snapshot,multiplier,high_multiplier_reason,
              base_amount,responsibility_amount,$2,$3
       FROM rework_responsibility_processes
       WHERE determination_id=$4`,
      [draftId, draftEventId, actor.requestId, revision.finalized_determination_id],
    );
    await client.query(
      `INSERT INTO rework_responsibility_allocations(
         determination_id,configuration_item_id,responsibility_type,share_bps,
         rounded_amount,operation_event_id,request_id,multiplier,supplier_id,
         supplier_version,supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot
       )
       SELECT $1,configuration_item_id,responsibility_type,share_bps,
              rounded_amount,$2,$3,multiplier,supplier_id,supplier_version,
              supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot
       FROM rework_responsibility_allocations
       WHERE determination_id=$4`,
      [draftId, draftEventId, actor.requestId, revision.finalized_determination_id],
    );
    await client.query(
      `INSERT INTO rework_responsibility_amount_lines
       SELECT $1,configuration_item_id,work_report_id,person_id,
              responsibility_type,base_member_share_amount,multiplier,
              share_bps,unrounded_amount,rounded_amount,rounding_rule,
              worker_display_name_snapshot,task_mode_snapshot,
              member_snapshot,report_snapshot,$2,$3
       FROM rework_responsibility_amount_lines
       WHERE determination_id=$4`,
      [draftId, draftEventId, actor.requestId, revision.finalized_determination_id],
    );
    const updated = await client.query(
      `UPDATE rework_orders
       SET version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP
       WHERE rework_order_id=$1
         AND status='pending_responsibility_determination'
         AND version=$3`,
      [reopenedOrder.rework_order_id, actor.actorId, reopenedOrder.version],
    );
    if (updated.rowCount !== 1) {
      fail("责任变更草稿创建时订单版本发生冲突");
    }
    await this.finalTodos?.actionableForResponsibilityHandler(client, actor, {
      category: "responsibility_determination",
      sourceEventId: draftEventId,
      sourceAction: "rework.responsibility.draft",
      entityType: "rework_order",
      entityId: reopenedOrder.rework_order_id,
      recipientUserId: actor.actorId,
      route: {
        routeName: "responsibility_detail",
        entityId: reopenedOrder.rework_order_id,
      },
      // A revision can reopen the order without implying a new determination
      // version. The draft event is the immutable fact that identifies this
      // projection, so it is the only safe discriminator for its todo.
      dedupeKey: `responsibility:${reopenedOrder.rework_order_id}:revision:${draftId}`,
    });
    return draftId;
  }

  private async enrichCase(
    value: ExternalResponsibilityCaseResponse,
    executor: Pool | PoolClient,
  ): Promise<ExternalResponsibilityCaseResponse> {
    if (!value.revisionRequests.length) return value;
    const linked = await executor.query<{
      revision_request_id: string;
      seeded_determination_id: string | null;
    }>(
      `SELECT revision_request_id,seeded_determination_id
       FROM rework_external_responsibility_revision_requests
       WHERE case_id=$1`,
      [value.caseId],
    );
    const seeds = new Map(
      linked.rows.map((item) => [
        item.revision_request_id,
        item.seeded_determination_id,
      ]),
    );
    return {
      ...value,
      revisionRequests: value.revisionRequests.map((item) => ({
        ...item,
        seededDeterminationId: seeds.get(item.revisionRequestId) ?? null,
      })),
    };
  }
}
