import { createHash, randomUUID } from "node:crypto";
import type {
  ApproveOwnFactoryApproval,
  OwnFactoryApprovalQueueResponse,
  OwnFactoryApprovalResponse,
  RejectOwnFactoryApproval,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { maybeCompleteResponsibilityAction } from "./external-responsibility-service.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type Queryable = Pool | PoolClient;
type Result<T> = { value: T; reused: boolean };
type ReworkStatus = OwnFactoryApprovalResponse["reworkStatus"];
type OrderRow = {
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkStatus;
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
type ApprovalRow = {
  approval_id: string;
  rework_order_id: string;
  finalized_determination_id: string;
  finalized_determination_version: number;
  approval_version: number;
  status: "pending" | "approved" | "rejected";
  own_factory_total_amount: string;
  source_snapshot: NonNullable<OwnFactoryApprovalResponse["approval"]>["sourceSnapshot"];
  created_at: Date;
};
type DecisionRow = {
  decision_id: string;
  decision: "approved" | "rejected";
  acted_by: string;
  actor_role_snapshot: string[];
  opinion: string | null;
  decided_at: Date;
};
type HistoryRow = {
  approval_id: string;
  finalized_determination_id: string;
  finalized_determination_version: number;
  approval_version: number;
  status: "pending" | "approved" | "rejected";
  own_factory_total_amount: string;
  created_at: Date;
  decision_id: string | null;
  decision: "approved" | "rejected" | null;
  acted_by: string | null;
  actor_role_snapshot: string[] | null;
  opinion: string | null;
  decided_at: Date | null;
};
type QueueRow = {
  approval_id: string;
  rework_order_id: string;
  rework_no: string | null;
  style_no: string | null;
  order_no: string | null;
  problem_part: string | null;
  order_version: number;
  approval_version: number;
  status: "pending" | "approved" | "rejected";
  own_factory_total_amount: string;
  can_decide: boolean;
};
type DecisionSelectionRow = Omit<ApprovalRow, "status"> & Omit<OrderRow, "status"> & {
  approval_status: ApprovalRow["status"];
  order_status: ReworkStatus;
};

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};
/**
 * N08-A only. The service stores and returns the server-built responsibility
 * snapshot; it never recomputes money from the live order, work reports, or
 * browser values.
 */
export class OwnFactoryApprovalService {
  private readonly idempotency = new IdempotencyService();
  private readonly events = new OperationEventRepository();

  constructor(
    private readonly database: Pool,
    private readonly todos?: TodoProjectionService,
  ) {}

  async ensureForFinalized(
    client: PoolClient,
    actor: TrustedActorContext,
    order: OrderRow,
    finalizedDeterminationId: string,
    createPendingAction = true,
  ): Promise<string | null> {
    const existing = await client.query<{ approval_id: string }>(
      "SELECT approval_id FROM rework_own_factory_approvals WHERE finalized_determination_id=$1",
      [finalizedDeterminationId],
    );
    if (existing.rows[0]) return existing.rows[0].approval_id;

    const source = await client.query<{
      determination_version: number;
      own_factory_total_amount: string;
    }>(
      `SELECT determination.determination_version,
              COALESCE(sum(allocation.rounded_amount), 0)::text own_factory_total_amount
       FROM rework_responsibility_determinations determination
       LEFT JOIN rework_responsibility_allocations allocation
         ON allocation.determination_id=determination.determination_id
        AND allocation.responsibility_type='own_factory'
       WHERE determination.determination_id=$1
         AND determination.rework_order_id=$2
         AND determination.stage='finalized'
       GROUP BY determination.determination_version`,
      [finalizedDeterminationId, order.rework_order_id],
    );
    const finalized = source.rows[0] ??
      fail("正式责任版本不存在", 409, "INVALID_STATE_TRANSITION");
    if (BigInt(finalized.own_factory_total_amount.replace(".", "")) === 0n) {
      return null;
    }

    const eventId = await this.appendEvent(
      client,
      actor,
      "rework.own_factory_approval.create",
      "responsibility:determine",
      order,
      "pending_responsibility_action",
      order.version + 1,
    );
    const approvalId = randomUUID();
    await client.query(
      `INSERT INTO rework_own_factory_approvals(
         approval_id,rework_order_id,finalized_determination_id,
         finalized_determination_version,approval_version,status,
         own_factory_total_amount,source_snapshot,created_operation_event_id,request_id
       )
       SELECT $1,$2,$3,$4,1,'pending',$5,
              own_factory_approval_source_snapshot($3),$6,$7`,
      [
        approvalId,
        order.rework_order_id,
        finalizedDeterminationId,
        finalized.determination_version,
        finalized.own_factory_total_amount,
        eventId,
        actor.requestId,
      ],
    );
    if (createPendingAction) {
      await this.todos?.actionableForAllDirectRole(client, actor, {
        category: "own_factory_approval",
        sourceEventId: eventId,
        sourceAction: "rework.own_factory_approval.create",
        entityType: "rework_order",
        entityId: order.rework_order_id,
        requiredRole: "owner_group",
        requiredCapability: "own_factory:approve",
        route: { routeName: "own_factory_approval", entityId: order.rework_order_id },
        policyKey: "general",
        dedupeKey: `own-factory-approval:${approvalId}`,
      });
    }
    return approvalId;
  }

  async approveDuringFinalization(
    client: PoolClient,
    actor: TrustedActorContext,
    approvalId: string,
    expectedOrderVersion: number,
  ): Promise<void> {
    await this.writeDecision(client, actor, approvalId, {
      expectedOrderVersion,
      expectedApprovalVersion: 1,
      opinion: "责任判定由具备本厂审批权限的老板本人最终确认，系统不再重复发起审批。",
    }, "approved");
  }

  async get(
    actor: TrustedActorContext,
    orderId: string,
    executor: Queryable = this.database,
  ): Promise<OwnFactoryApprovalResponse> {
    const order = await this.order(executor, orderId, false);
    const canView = await this.canView(executor, actor, orderId);
    if (!canView) fail("当前用户无权查看本厂承担审批", 403, "FORBIDDEN");
    const approvalResult = await executor.query<ApprovalRow>(
      `SELECT approval_id,rework_order_id,finalized_determination_id,
              finalized_determination_version,approval_version,status,
              own_factory_total_amount::text,source_snapshot,created_at
       FROM rework_own_factory_approvals
       WHERE rework_order_id=$1
       ORDER BY created_at DESC
       LIMIT 1`,
      [orderId],
    );
    const approval = approvalResult.rows[0];
    if (!approval) {
      return {
        reworkOrderId: order.rework_order_id,
        reworkStatus: order.status,
        orderVersion: order.version,
        canView,
        canDecide: false,
        approval: null,
        history: [],
      };
    }
    const decisionResult = await executor.query<DecisionRow>(
      `SELECT decision_id,decision,acted_by,actor_role_snapshot,opinion,decided_at
       FROM rework_own_factory_approval_decisions WHERE approval_id=$1`,
      [approval.approval_id],
    );
    const decision = decisionResult.rows[0];
    const history = await this.history(executor, orderId);
    const canDecide = approval.status === "pending"
      && await this.canDecide(executor, actor.actorId, orderId);
    return {
      reworkOrderId: order.rework_order_id,
      reworkStatus: order.status,
      orderVersion: order.version,
      canView,
      canDecide,
      approval: {
        approvalId: approval.approval_id,
        finalizedDeterminationId: approval.finalized_determination_id,
        finalizedDeterminationVersion: approval.finalized_determination_version,
        approvalVersion: approval.approval_version,
        status: approval.status,
        ownFactoryTotalAmount: approval.own_factory_total_amount,
        sourceSnapshot: approval.source_snapshot,
        createdAt: approval.created_at.toISOString(),
        decision: decision
          ? {
              decisionId: decision.decision_id,
              decision: decision.decision,
              actedBy: decision.acted_by,
              actorRoleSnapshot: decision.actor_role_snapshot,
              opinion: decision.opinion,
              decidedAt: decision.decided_at.toISOString(),
              otherOwnersNotified: true,
            }
          : null,
      },
      history,
    };
  }

  async listQueue(actor: TrustedActorContext): Promise<OwnFactoryApprovalQueueResponse> {
    const result = await this.database.query<QueueRow>(
      `SELECT approval.approval_id,approval.rework_order_id,order_record.rework_no,
              order_record.style_no,order_record.order_no,order_record.problem_part,
              order_record.version order_version,approval.approval_version,
              approval.status,approval.own_factory_total_amount::text,
              own_factory_approval_can_decide($1,approval.rework_order_id) can_decide
       FROM rework_own_factory_approvals approval
       JOIN rework_orders order_record ON order_record.rework_order_id=approval.rework_order_id
       WHERE approval.status='pending'
         AND own_factory_approval_can_view($1,approval.rework_order_id)
       ORDER BY approval.created_at ASC
       LIMIT 200`,
      [actor.actorId],
    );
    return {
      items: result.rows.map((row) => ({
        approvalId: row.approval_id,
        reworkOrderId: row.rework_order_id,
        reworkNo: row.rework_no,
        styleNo: row.style_no,
        orderNo: row.order_no,
        problemPart: row.problem_part,
        orderVersion: row.order_version,
        approvalVersion: row.approval_version,
        status: row.status,
        ownFactoryTotalAmount: row.own_factory_total_amount,
        canDecide: row.can_decide,
      })),
    };
  }

  async approve(
    actor: TrustedActorContext,
    approvalId: string,
    input: ApproveOwnFactoryApproval,
    key: string,
  ): Promise<Result<OwnFactoryApprovalResponse>> {
    return this.decide(actor, approvalId, input, key, "approved");
  }

  async reject(
    actor: TrustedActorContext,
    approvalId: string,
    input: RejectOwnFactoryApproval,
    key: string,
  ): Promise<Result<OwnFactoryApprovalResponse>> {
    return this.decide(actor, approvalId, input, key, "rejected");
  }

  private async decide(
    actor: TrustedActorContext,
    approvalId: string,
    input: ApproveOwnFactoryApproval | RejectOwnFactoryApproval,
    key: string,
    decision: "approved" | "rejected",
  ): Promise<Result<OwnFactoryApprovalResponse>> {
    if (decision === "rejected" && !input.opinion?.trim()) {
      fail("驳回必须填写原因", 400, "VALIDATION_ERROR");
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute(client, {
        scope: `rework.own_factory_approval.${decision}`,
        actorKey: actor.actorId,
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify({ approvalId, input, decision }))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 200,
        response: await this.writeDecision(client, actor, approvalId, input, decision),
      }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async writeDecision(
    client: PoolClient,
    actor: TrustedActorContext,
    approvalId: string,
    input: ApproveOwnFactoryApproval | RejectOwnFactoryApproval,
    decision: "approved" | "rejected",
  ): Promise<OwnFactoryApprovalResponse> {
    const result = await client.query<DecisionSelectionRow>(
      `SELECT approval.approval_id,approval.rework_order_id,
              approval.finalized_determination_id,approval.finalized_determination_version,
              approval.approval_version,approval.status approval_status,approval.own_factory_total_amount::text,
              approval.source_snapshot,approval.created_at,
              order_record.rework_no,order_record.status order_status,order_record.version,
              order_record.style_no,order_record.order_no,order_record.merchandiser_user_id,
              order_record.processing_factory_type,order_record.processing_factory_supplier_id,
              order_record.processing_factory_supplier_version,order_record.problem_part,
              order_record.problem_description,order_record.rework_quantity
       FROM rework_own_factory_approvals approval
       JOIN rework_orders order_record ON order_record.rework_order_id=approval.rework_order_id
       WHERE approval.approval_id=$1
       FOR UPDATE OF approval,order_record`,
      [approvalId],
    );
    const current = result.rows[0] ?? fail("本厂承担审批不存在", 404, "NOT_FOUND");
    const order: OrderRow = { ...current, status: current.order_status };
    if (current.approval_status !== "pending") fail("本厂承担审批已经处理");
    if (order.status !== "pending_responsibility_action") {
      fail("返工单不在本厂承担审批状态", 409, "INVALID_STATE_TRANSITION");
    }
    if (order.version !== input.expectedOrderVersion
      || current.approval_version !== input.expectedApprovalVersion) {
      fail("审批版本冲突");
    }
    if (!(await this.canDecide(client, actor.actorId, order.rework_order_id))) {
      fail("仅直接有效老板或有效订单范围代理可处理本厂承担", 403, "FORBIDDEN");
    }
    const action = decision === "approved"
      ? "rework.own_factory_approval.approve"
      : "rework.own_factory_approval.reject";
    const nextStatus = decision === "rejected"
      ? "pending_responsibility_determination"
      : "pending_responsibility_action";
    const nextVersion = decision === "rejected" ? order.version + 1 : order.version;
    const eventId = await this.appendEvent(
      client,
      actor,
      action,
      "own_factory:approve",
      order,
      nextStatus,
      nextVersion,
      input.opinion ?? undefined,
    );
    await client.query(
      `INSERT INTO rework_own_factory_approval_decisions(
         decision_id,approval_id,decision,acted_by,actor_role_snapshot,
         opinion,operation_event_id,request_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        randomUUID(),
        approvalId,
        decision,
        actor.actorId,
        [...new Set(actor.actorRoles)].sort(),
        input.opinion ?? null,
        eventId,
        actor.requestId,
      ],
    );
    await client.query(
      `UPDATE rework_own_factory_approvals
       SET status=$2,approval_version=approval_version+1
       WHERE approval_id=$1`,
      [approvalId, decision],
    );
    if (decision === "rejected") {
      await client.query(
        `UPDATE rework_orders
         SET status='pending_responsibility_determination',version=version+1,
             updated_by=$2,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [order.rework_order_id, actor.actorId],
      );
    }
    if (decision === "approved") {
      await maybeCompleteResponsibilityAction(client, actor, order);
    }
    await this.todos?.completeOpenByDedupePrefix(
      client,
      actor,
      `own-factory-approval:${approvalId}:`,
      "A direct owner completed the parallel own-factory approval",
    );
    return this.get(actor, order.rework_order_id, client);
  }

  private async order(
    client: Queryable,
    orderId: string,
    locked: boolean,
  ): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,processing_factory_supplier_version,
              problem_part,problem_description,rework_quantity
       FROM rework_orders WHERE rework_order_id=$1 ${locked ? "FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
  }

  private async canView(
    client: Queryable,
    actor: TrustedActorContext,
    orderId: string,
  ): Promise<boolean> {
    const result = await client.query<{ permitted: boolean }>(
      "SELECT own_factory_approval_can_view($1,$2) permitted",
      [actor.actorId, orderId],
    );
    return result.rows[0]?.permitted === true;
  }

  private async canDecide(
    client: Queryable,
    actorId: string,
    orderId: string,
  ): Promise<boolean> {
    const result = await client.query<{ permitted: boolean }>(
      "SELECT own_factory_approval_can_decide($1,$2) permitted",
      [actorId, orderId],
    );
    return result.rows[0]?.permitted === true;
  }

  private async history(
    executor: Queryable,
    orderId: string,
  ): Promise<OwnFactoryApprovalResponse["history"]> {
    const result = await executor.query<HistoryRow>(
      `SELECT approval.approval_id,approval.finalized_determination_id,
              approval.finalized_determination_version,approval.approval_version,
              approval.status,approval.own_factory_total_amount::text,approval.created_at,
              decision.decision_id,decision.decision,decision.acted_by,
              decision.actor_role_snapshot,decision.opinion,decision.decided_at
       FROM rework_own_factory_approvals approval
       LEFT JOIN rework_own_factory_approval_decisions decision
         ON decision.approval_id=approval.approval_id
       WHERE approval.rework_order_id=$1
       ORDER BY approval.finalized_determination_version DESC,approval.created_at DESC`,
      [orderId],
    );
    return result.rows.map((row) => ({
      approvalId: row.approval_id,
      finalizedDeterminationId: row.finalized_determination_id,
      finalizedDeterminationVersion: row.finalized_determination_version,
      approvalVersion: row.approval_version,
      status: row.status,
      ownFactoryTotalAmount: row.own_factory_total_amount,
      createdAt: row.created_at.toISOString(),
      decision: row.decision_id && row.decision && row.acted_by
        && row.actor_role_snapshot && row.decided_at
        ? {
            decisionId: row.decision_id,
            decision: row.decision,
            actedBy: row.acted_by,
            actorRoleSnapshot: row.actor_role_snapshot,
            opinion: row.opinion,
            decidedAt: row.decided_at.toISOString(),
            otherOwnersNotified: true,
          }
        : null,
    }));
  }

  private orderAudit(
    order: OrderRow,
    status: ReworkStatus,
    version: number,
  ): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null :
        order.processing_factory_type === "own_factory" ? { type: "own_factory" } : {
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

  private async appendEvent(
    client: PoolClient,
    actor: TrustedActorContext,
    action: string,
    capability: string,
    order: OrderRow,
    nextStatus: ReworkStatus,
    nextVersion: number,
    reason?: string,
  ): Promise<string> {
    const eventId = await this.events.append(
      client,
      { ...actor, authorizationCapability: capability },
      {
        action,
        entityType: "rework_order",
        entityId: order.rework_order_id,
        before: this.orderAudit(order, order.status, order.version),
        after: this.orderAudit(order, nextStatus, nextVersion),
        ...(reason ? { reason } : {}),
      },
    );
    await client.query(
      `SELECT set_config('dx_rework.own_factory_approval_event_id',$1,true),
              set_config('dx_rework.own_factory_approval_request_id',$2,true)`,
      [eventId, actor.requestId],
    );
    if (action === "rework.own_factory_approval.reject") {
      await client.query(
        `SELECT set_config('dx_rework.rework_event_id',$1,true),
                set_config('dx_rework.rework_request_id',$2,true)`,
        [eventId, actor.requestId],
      );
    }
    return eventId;
  }

}
