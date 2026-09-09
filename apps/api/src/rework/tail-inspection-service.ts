import { createHash, randomUUID } from "node:crypto";

import type {
  SubmitTailInspectionReport,
  TailInspectionOptionsResponse,
  TailInspectionResponse,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { ensureWithinSourceReceivingActualQuantity } from "./receiving-quantity-ceiling.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

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
type AssignmentRow = Readonly<{
  tail_inspection_assignment_id: string;
  rework_order_id: string;
  tail_inspector_user_id: string;
  display_name: string;
  box_scope: string | null;
  revoked_at: Date | null;
  returned_quantity: string | null;
  submitted_at: Date | null;
}>;
type ConfigurationItemRow = Readonly<{
  configuration_item_id: string;
  process_name: string;
}>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};

const isOpenForTailInspection = (status: string): boolean => [
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
].includes(status);

/** Independent N06 physical count. It never derives quantities from a plan. */
export class TailInspectionService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async listOptions(actor: TrustedActorContext): Promise<TailInspectionOptionsResponse> {
    this.ensureSupervisor(actor);
    const result = await this.database.query<{ id: string; person_id: string; display_name: string }>(
      `SELECT DISTINCT user_row.id,person.person_id,user_row.display_name
       FROM app_users user_row
       JOIN user_role_assignments assignment
         ON assignment.user_id=user_row.id
        AND assignment.role_code='worker'
        AND assignment.revoked_at IS NULL
       JOIN business_roles role
         ON role.role_code=assignment.role_code AND role.enabled=true
       JOIN role_capabilities capability
         ON capability.role_code=assignment.role_code
        AND capability.capability='tail_inspection:report'
       JOIN business_people person
         ON person.app_user_id=user_row.id
        AND person.person_type='internal'
        AND person.active=true
       WHERE user_row.enabled=true
       ORDER BY user_row.display_name,user_row.id`,
    );
    return { inspectors: result.rows.map((row) => ({ userId: row.id, personId: row.person_id, displayName: row.display_name })) };
  }

  async get(actor: TrustedActorContext, reworkOrderId: string): Promise<TailInspectionResponse> {
    this.ensureRead(actor);
    const order = await this.order(this.database, reworkOrderId, false);
    return this.dto(this.database, actor, order);
  }

  private async dto(
    client: Pick<Pool, "query"> | PoolClient,
    actor: TrustedActorContext,
    order: OrderRow,
  ): Promise<TailInspectionResponse> {
    const reworkOrderId = order.rework_order_id;
    const assignments = await this.assignments(client, reworkOrderId, actor);
    const processes = await this.processes(client, reworkOrderId);
    const reported = await client.query<{ configuration_item_id: string; inspected_quantity: string }>(
      `SELECT item.configuration_item_id,COALESCE(sum(item.inspected_quantity),0) AS inspected_quantity
       FROM rework_tail_inspection_report_items item
       JOIN rework_tail_inspection_reports report
         ON report.tail_inspection_report_id=item.tail_inspection_report_id
        AND report.status='submitted'
       JOIN rework_tail_inspection_assignments assignment
         ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id
        AND assignment.revoked_at IS NULL
       WHERE report.rework_order_id=$1
       GROUP BY item.configuration_item_id`,
      [reworkOrderId],
    );
    const quantities = new Map(reported.rows.map((row) => [row.configuration_item_id, Number(row.inspected_quantity)]));
    const rootCanSubmit = isRootActor(actor);
    return {
      reworkOrderId,
      reworkStatus: order.status as TailInspectionResponse["reworkStatus"],
      assignments: assignments.map((assignment) => ({
        assignmentId: assignment.tail_inspection_assignment_id,
        tailInspectorUserId: assignment.tail_inspector_user_id,
        tailInspectorName: assignment.display_name,
        boxScope: assignment.box_scope,
        status: assignment.revoked_at === null ? "active" as const : "revoked" as const,
        returnedQuantity: assignment.returned_quantity === null ? null : Number(assignment.returned_quantity),
        submittedAt: assignment.submitted_at?.toISOString() ?? null,
        canSubmit: assignment.revoked_at === null
          && assignment.returned_quantity === null
          && (assignment.tail_inspector_user_id === actor.actorId || rootCanSubmit)
          && isOpenForTailInspection(order.status),
      })),
      processes: processes.map((item) => ({
        configurationItemId: item.configuration_item_id,
        processName: item.process_name,
        inspectedQuantity: quantities.get(item.configuration_item_id) ?? 0,
      })),
    };
  }

  async submit(
    actor: TrustedActorContext,
    assignmentId: string,
    input: SubmitTailInspectionReport,
    idempotencyKey: string,
  ): Promise<Result<TailInspectionResponse>> {
    this.ensureReporter(actor);
    return this.mutate(actor, "rework.tail_inspection.submit", idempotencyKey, { assignmentId, ...input }, 201, async (client) => {
      const assignment = await this.assignment(client, assignmentId, true);
      const order = await this.order(client, assignment.rework_order_id, true);
      if (assignment.revoked_at !== null) fail("该整查分配已失效，请联系尾部主管重新分配", 409, "INVALID_STATE_TRANSITION");
      if (!isRootActor(actor) && assignment.tail_inspector_user_id !== actor.actorId) {
        fail("只能提交本人被分配的整查报数", 403, "FORBIDDEN");
      }
      if (!isOpenForTailInspection(order.status)) fail("当前返工单不在整查报数范围", 409, "INVALID_STATE_TRANSITION");
      const existing = await client.query(
        `SELECT 1 FROM rework_tail_inspection_reports
         WHERE tail_inspection_assignment_id=$1 AND status='submitted' FOR UPDATE`,
        [assignmentId],
      );
      if (existing.rowCount) fail("该整查人员已提交报数；如需调整请由尾部主管退回", 409, "CONFLICT");
      const processes = await this.processes(client, assignment.rework_order_id, true);
      const expected = new Set(processes.map((item) => item.configuration_item_id));
      if (input.items.length !== expected.size || input.items.some((item) => !expected.has(item.configurationItemId))) {
        fail("整查报数必须覆盖当前工序且不能包含其他工序", 400, "VALIDATION_ERROR");
      }
      await ensureWithinSourceReceivingActualQuantity(client, assignment.rework_order_id, [
        { label: "整查返件总数", quantity: input.returnedQuantity },
        ...input.items.map((item) => ({ label: "整查工序数量", quantity: item.inspectedQuantity })),
      ]);
      const readyAfterSubmit = order.status === "in_progress"
        && await this.readyForWholeOrderReview(client, assignment.rework_order_id, assignmentId);
      const reportId = randomUUID();
      const eventId = await this.events.append(client, actor, {
        action: "rework.tail_inspection.submit",
        entityType: "rework_tail_inspection_assignment",
        entityId: assignmentId,
        before: {
          reworkOrderId: assignment.rework_order_id,
          assignmentId,
          report: null,
          orderStatus: order.status,
          orderVersion: order.version,
        },
        after: {
          ...this.orderAudit(order, readyAfterSubmit ? "pending_order_review" : order.status, readyAfterSubmit ? order.version + 1 : order.version),
          assignmentId,
          tailInspectionReportId: reportId,
          returnedQuantity: input.returnedQuantity,
          items: input.items,
        },
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        `INSERT INTO rework_tail_inspection_reports(
           tail_inspection_report_id,tail_inspection_assignment_id,rework_order_id,
           returned_quantity,status,submitted_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,'submitted',$5,$6,$7)`,
        [reportId, assignmentId, assignment.rework_order_id, input.returnedQuantity, actor.actorId, eventId, actor.requestId],
      );
      for (const item of input.items) {
        await client.query(
          `INSERT INTO rework_tail_inspection_report_items(
             tail_inspection_report_id,configuration_item_id,inspected_quantity
           ) VALUES($1,$2,$3)`,
          [reportId, item.configurationItemId, item.inspectedQuantity],
        );
      }
      if (readyAfterSubmit) {
        const orderTransitionEventId = await this.events.append(client, actor, {
          action: "rework.tail_inspection.submit",
          entityType: "rework_order",
          entityId: assignment.rework_order_id,
          before: this.orderAudit(order, order.status, order.version),
          after: {
            ...this.orderAudit(order, "pending_order_review", order.version + 1),
            assignmentId,
            tailInspectionReportId: reportId,
          },
        });
        await this.context(client, orderTransitionEventId, actor.requestId);
        await client.query(
          `UPDATE rework_orders
           SET status='pending_order_review',updated_by=$2,updated_at=CURRENT_TIMESTAMP,version=version+1
           WHERE rework_order_id=$1 AND version=$3`,
          [assignment.rework_order_id, actor.actorId, order.version],
        );
      }
      await this.todos?.completeOpenByDedupeKey(
        client,
        actor,
        `tail-inspection:${assignment.rework_order_id}:${assignmentId}`,
        "Tail inspection count was submitted",
      );
      return this.dto(client, actor, await this.order(client, assignment.rework_order_id, false));
    });
  }

  async reject(
    actor: TrustedActorContext,
    assignmentId: string,
    input: { expectedOrderVersion: number; reason: string },
    idempotencyKey: string,
  ): Promise<Result<TailInspectionResponse>> {
    this.ensureReviewer(actor);
    return this.mutate(actor, "rework.tail_inspection.reject", idempotencyKey, { assignmentId, ...input }, 200, async (client) => {
      const assignment = await this.assignment(client, assignmentId, true);
      const order = await this.order(client, assignment.rework_order_id, true);
      if (order.version !== input.expectedOrderVersion) fail("返工单版本冲突，请刷新后重试");
      if (order.status !== "pending_order_review") fail("只有 N07 整单确认阶段可以驳回整查报数", 409, "INVALID_STATE_TRANSITION");
      if (assignment.revoked_at !== null) fail("该整查分配已失效", 409, "INVALID_STATE_TRANSITION");
      const report = await client.query<{ tail_inspection_report_id: string; returned_quantity: string }>(
        `SELECT tail_inspection_report_id,returned_quantity
         FROM rework_tail_inspection_reports
         WHERE tail_inspection_assignment_id=$1 AND status='submitted'
         ORDER BY submitted_at DESC,tail_inspection_report_id DESC
         LIMIT 1 FOR UPDATE`,
        [assignmentId],
      );
      const current = report.rows[0] ?? fail("当前没有可驳回的整查报数", 409, "CONFLICT");
      const reason = input.reason.trim();
      if (!reason) fail("驳回整查必须填写原因", 400, "VALIDATION_ERROR");
      const eventId = await this.events.append(client, actor, {
        action: "rework.tail_inspection.reject",
        entityType: "rework_tail_inspection_assignment",
        entityId: assignmentId,
        before: {
          reworkOrderId: assignment.rework_order_id,
          assignmentId,
          tailInspectionReportId: current.tail_inspection_report_id,
          status: "submitted",
          returnedQuantity: Number(current.returned_quantity),
          orderStatus: order.status,
          orderVersion: order.version,
        },
        after: {
          reworkOrderId: assignment.rework_order_id,
          assignmentId,
          tailInspectionReportId: current.tail_inspection_report_id,
          status: "rejected",
          orderStatus: order.status,
          orderVersion: order.version,
        },
        reason,
      });
      await this.context(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_tail_inspection_reports
         SET status='rejected',rejected_at=CURRENT_TIMESTAMP,rejected_by=$2,rejection_reason=$3
         WHERE tail_inspection_report_id=$1 AND status='submitted'`,
        [current.tail_inspection_report_id, actor.actorId, reason],
      );
      await this.todos?.actionableForNamedRecipient(client, actor, {
        category: "tail_inspection",
        sourceEventId: eventId,
        sourceAction: "rework.tail_inspection.reject",
        entityType: "rework_tail_inspection_assignment",
        entityId: assignmentId,
        recipientUserId: assignment.tail_inspector_user_id,
        requiredRole: "worker",
        requiredCapability: "tail_inspection:report",
        route: { routeName: "rework_detail", entityId: assignment.rework_order_id, tab: "tail_inspection" },
        policyKey: "general",
        dedupeKey: `tail-inspection-return:${current.tail_inspection_report_id}`,
      });
      return this.dto(client, actor, order);
    });
  }

  private ensureSupervisor(actor: TrustedActorContext): void {
    if (!isRootActor(actor) && (!actor.actorRoles.includes("tail_supervisor") || actor.authorizationCapability !== "process:configure")) {
      fail("只有尾部主管可以分配整查人员", 403, "FORBIDDEN");
    }
  }

  private ensureReporter(actor: TrustedActorContext): void {
    if (!isRootActor(actor) && (!actor.actorRoles.includes("worker") || actor.authorizationCapability !== "tail_inspection:report")) {
      fail("只有被分配整查的工人可以提交整查报数", 403, "FORBIDDEN");
    }
  }

  private ensureReviewer(actor: TrustedActorContext): void {
    if (!isRootActor(actor) && (!actor.actorRoles.includes("tail_supervisor") || actor.authorizationCapability !== "submission:audit")) {
      fail("只有尾部主管可以驳回整查报数", 403, "FORBIDDEN");
    }
  }

  private ensureRead(actor: TrustedActorContext): void {
    if (isRootActor(actor)) return;
    // Current HTTP authorization emits worker. The retired role is accepted only for immutable
    // historical actor snapshots and direct legacy service fixtures; it is never assigned anew.
    const reporter = (actor.actorRoles.includes("worker") || actor.actorRoles.includes("tail_inspector"))
      && actor.authorizationCapability === "tail_inspection:report";
    const supervisor = actor.actorRoles.includes("tail_supervisor") && ["process:configure", "submission:audit"].includes(actor.authorizationCapability);
    if (!reporter && !supervisor) fail("当前角色无权查看整查报数", 403, "FORBIDDEN");
  }

  private async order(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, locked: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,
              processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,
              problem_part,problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'${locked ? " FOR UPDATE" : ""}`,
      [reworkOrderId],
    );
    return result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
  }

  private async assignment(client: PoolClient, assignmentId: string, locked: boolean): Promise<AssignmentRow> {
    const result = await client.query<AssignmentRow>(
      `SELECT assignment.tail_inspection_assignment_id,assignment.rework_order_id,
              assignment.tail_inspector_user_id,user_row.display_name,assignment.box_scope,
              assignment.revoked_at,report.returned_quantity,report.submitted_at
       FROM rework_tail_inspection_assignments assignment
       JOIN app_users user_row ON user_row.id=assignment.tail_inspector_user_id
       LEFT JOIN LATERAL (
         SELECT returned_quantity,submitted_at
         FROM rework_tail_inspection_reports
         WHERE tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
           AND status='submitted'
         ORDER BY submitted_at DESC,tail_inspection_report_id DESC LIMIT 1
       ) report ON true
       WHERE assignment.tail_inspection_assignment_id=$1${locked ? " FOR UPDATE OF assignment" : ""}`,
      [assignmentId],
    );
    return result.rows[0] ?? fail("整查分配不存在", 404, "NOT_FOUND");
  }

  private async assignments(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, actor: TrustedActorContext): Promise<AssignmentRow[]> {
    const ownOnly = !isRootActor(actor)
      && !(actor.actorRoles.includes("tail_supervisor") && ["process:configure", "submission:audit"].includes(actor.authorizationCapability));
    const result = await client.query<AssignmentRow>(
      `SELECT assignment.tail_inspection_assignment_id,assignment.rework_order_id,
              assignment.tail_inspector_user_id,user_row.display_name,assignment.box_scope,
              assignment.revoked_at,report.returned_quantity,report.submitted_at
       FROM rework_tail_inspection_assignments assignment
       JOIN app_users user_row ON user_row.id=assignment.tail_inspector_user_id
       LEFT JOIN LATERAL (
         SELECT returned_quantity,submitted_at
         FROM rework_tail_inspection_reports
         WHERE tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
           AND status='submitted'
         ORDER BY submitted_at DESC,tail_inspection_report_id DESC LIMIT 1
       ) report ON true
       WHERE assignment.rework_order_id=$1${ownOnly ? " AND assignment.tail_inspector_user_id=$2" : ""}
       ORDER BY assignment.assigned_at,assignment.tail_inspection_assignment_id`,
      ownOnly ? [reworkOrderId, actor.actorId] : [reworkOrderId],
    );
    return result.rows;
  }

  private async processes(client: Pick<Pool, "query"> | PoolClient, reworkOrderId: string, locked = false): Promise<ConfigurationItemRow[]> {
    const result = await client.query<ConfigurationItemRow>(
      `SELECT item.configuration_item_id,item.process_name
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
       WHERE configuration.rework_order_id=$1
         AND configuration.status IN ('pending_ie_review','approved')
       ORDER BY configuration.configuration_version DESC,item.position,item.configuration_item_id${locked ? " FOR SHARE OF configuration,item" : ""}`,
      [reworkOrderId],
    );
    return result.rows;
  }

  private async readyForWholeOrderReview(client: PoolClient, reworkOrderId: string, submittedAssignmentId?: string): Promise<boolean> {
    const result = await client.query<{ ready: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM rework_work_tasks task
         WHERE task.rework_order_id=$1 AND task.status='active'
       )
       AND NOT EXISTS(
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
       AND EXISTS(
         SELECT 1 FROM rework_tail_inspection_assignments assignment
         WHERE assignment.rework_order_id=$1 AND assignment.revoked_at IS NULL
       )
       AND NOT EXISTS(
         SELECT 1 FROM rework_tail_inspection_assignments assignment
         WHERE assignment.rework_order_id=$1 AND assignment.revoked_at IS NULL
           AND assignment.tail_inspection_assignment_id IS DISTINCT FROM $2::uuid
           AND NOT EXISTS(
             SELECT 1 FROM rework_tail_inspection_reports report
             WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
               AND report.status='submitted'
           )
       ) AS ready`,
      [reworkOrderId, submittedAssignmentId ?? null],
    );
    return result.rows[0]?.ready === true;
  }

  private orderAudit(order: OrderRow, status: string, version: number): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory"
        ? { type: "own_factory" }
        : { type: "supplier", supplierId: order.processing_factory_supplier_id, supplierVersion: order.processing_factory_supplier_version },
      problemPart: order.problem_part,
      problemDescription: order.problem_description,
      reworkQuantity: order.rework_quantity,
      version,
    };
  }

  private async context(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
      [eventId, requestId],
    );
  }

  private async mutate<T>(actor: TrustedActorContext, scope: string, key: string, payload: unknown, statusCode: number, work: (client: PoolClient) => Promise<T>): Promise<Result<T>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key,
        requestHash: hash(scope, payload),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode, response: await work(client) }));
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
