import { createHash } from "node:crypto";

import type { AssignRole } from "@dx-rework/contracts";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import { AccessMasterDataService } from "./service.js";

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

/**
 * Keeps execution roles and the business-person model synchronized.
 * The retired tail-inspector role is normalized to the ordinary worker role;
 * tail inspection remains an execution capability of workers rather than a
 * standalone personnel role.
 */
export class WorkerAwareAccessMasterDataService extends AccessMasterDataService {
  private readonly correctionIdempotency = new IdempotencyService();
  private readonly correctionEvents = new OperationEventRepository();

  constructor(
    private readonly operationalDatabase: Pool,
    corporationId: string,
  ) {
    super(operationalDatabase, corporationId);
  }

  override async assignRole(
    actor: TrustedActorContext,
    input: AssignRole,
  ): Promise<{ assignmentId: string }> {
    const effectiveInput: AssignRole = input.roleCode === "tail_inspector"
      ? { ...input, roleCode: "worker", reason: `${input.reason}（独立整查角色已退役，按普通工人授权）` }
      : input;
    const assignment = await super.assignRole(actor, effectiveInput);
    if (effectiveInput.roleCode !== "worker") return assignment;
    const roleLabel = "工人";

    try {
      const people = await this.listPeople({ includeInactive: true });
      if (people.some((person) => person.appUserId === effectiveInput.userId)) {
        return assignment;
      }

      const roleAssignments = await this.listRoleAssignments({
        userId: effectiveInput.userId,
        includeRevoked: false,
      });
      const executionAssignment = roleAssignments.find(
        (item) => item.assignmentId === assignment.assignmentId,
      );
      if (!executionAssignment) {
        throw new ApplicationError(
          "CONFLICT",
          `${roleLabel}角色已建立，但无法读取员工身份用于作业人员建档`,
          409,
        );
      }

      const masterDataActor: TrustedActorContext = {
        ...actor,
        authorizationCapability: "master_data:manage",
        authorizationCapabilities: [
          ...new Set([
            ...(actor.authorizationCapabilities ?? [actor.authorizationCapability]),
            "master_data:manage",
          ]),
        ],
      };
      await this.createPerson(masterDataActor, {
        personType: "internal",
        appUserId: effectiveInput.userId,
        displayName: executionAssignment.displayName,
        aliases: [],
        reason: `授予${roleLabel}角色自动建立内部作业人员档案`,
      });
      return assignment;
    } catch (error: unknown) {
      try {
        await super.revokeRole(
          actor,
          assignment.assignmentId,
          `内部作业人员档案建立失败，系统自动回滚${roleLabel}角色授予`,
        );
      } catch {
        throw new ApplicationError(
          "CONFLICT",
          `${roleLabel}角色建档失败且自动回滚未完成，请在权限管理核对该员工状态`,
          409,
        );
      }
      throw error;
    }
  }

  async removeWorkAssignment(
    actor: TrustedActorContext,
    workTaskId: string,
    expectedOrderVersion: number,
    idempotencyKey: string,
  ): Promise<{ reused: boolean }> {
    const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (!capabilities.includes("work:assign")) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权调整返工人员分配", 403);
    }

    const action = "rework.work_task.remove";
    const payload = { workTaskId, expectedOrderVersion };
    const client = await this.operationalDatabase.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.correctionIdempotency.execute(
        client,
        {
          scope: action,
          actorKey: actor.actorId,
          key: idempotencyKey,
          requestHash: hash(action, payload),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        async () => {
          const taskResult = await client.query<{
            work_task_id: string;
            rework_order_id: string;
            configuration_item_id: string;
            task_version: number;
            task_status: "active" | "superseded";
            order_status: string;
            order_version: number;
          }>(
            `SELECT task.work_task_id,task.rework_order_id,task.configuration_item_id,
                    task.task_version,task.status task_status,
                    rework.status order_status,rework.version order_version
             FROM rework_work_tasks task
             JOIN rework_orders rework ON rework.rework_order_id=task.rework_order_id
             WHERE task.work_task_id=$1
             FOR UPDATE OF task,rework`,
            [workTaskId],
          );
          const task = taskResult.rows[0];
          if (!task) throw new ApplicationError("NOT_FOUND", "返工人员分配不存在", 404);
          if (task.order_status !== "pending_task_assignment") {
            throw new ApplicationError("INVALID_STATE_TRANSITION", "返工已经开始，不能再移除已分配人员", 409);
          }
          if (task.order_version !== expectedOrderVersion) {
            throw new ApplicationError("CONFLICT", "返工单已被其他操作更新，请刷新后重试", 409);
          }
          if (task.task_status !== "active") {
            throw new ApplicationError("CONFLICT", "该人员分配已经被调整，请刷新后重试", 409);
          }
          const report = await client.query(
            "SELECT 1 FROM rework_work_reports WHERE work_task_id=$1 LIMIT 1",
            [workTaskId],
          );
          if (report.rows[0]) {
            throw new ApplicationError("CONFLICT", "已有上数记录的人员分配不能移除", 409);
          }

          const eventId = await this.correctionEvents.append(client, actor, {
            action,
            entityType: "rework_order",
            entityId: task.rework_order_id,
            before: {
              workTaskId: task.work_task_id,
              configurationItemId: task.configuration_item_id,
              taskVersion: task.task_version,
              status: "active",
            },
            after: {
              workTaskId: task.work_task_id,
              configurationItemId: task.configuration_item_id,
              taskVersion: task.task_version,
              status: "superseded",
            },
            reason: "撤销错误的返工人员分配",
          });
          await client.query(
            "SELECT set_config('dx_rework.work_event_id',$1,true),set_config('dx_rework.work_request_id',$2,true)",
            [eventId, actor.requestId],
          );
          await client.query(
            "UPDATE rework_work_tasks SET status='superseded',superseded_at=CURRENT_TIMESTAMP WHERE work_task_id=$1",
            [workTaskId],
          );
          return { statusCode: 204, response: { removed: true } };
        },
      );
      await client.query("COMMIT");
      return { reused: outcome.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}