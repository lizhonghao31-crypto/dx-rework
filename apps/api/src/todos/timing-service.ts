import {effectiveSourcingDueSql} from '../production-platform/sla-sourcing-deadline-sql.js';
import { memberCanReceiveFact } from "../access/member-module-policy.js";
import type { Pool, PoolClient } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import { TodoProjectionService } from "./projection-service.js";
import { TodoService, type TimedTodoAction } from "./service.js";

export type TodoTimingRunResult = Readonly<{
  claimed: number;
  overdueCandidates: number;
  overdueTodos: number;
  reminders: number;
  escalations: number;
  escalationNotifications: number;
  noLongerDue: number;
}>;

type ScheduledTimingAction = Readonly<{
  action: TimedTodoAction;
  escalationNotificationCount: number;
}>;

/**
 * The runtime calls this with a separately trusted platform actor. It does
 * not contain a timer, credentials or a production delivery adapter: PR-13
 * only supplies the transactional scheduler primitive and leaves deployment
 * ownership outside this change set.
 */
export class TodoTimingService {
  constructor(
    private readonly database: Pool,
    private readonly todos = new TodoService(database),
    private readonly projections = new TodoProjectionService(todos),
  ) {}

  async runOnce(
    actor: TrustedActorContext,
    limit = 50,
  ): Promise<TodoTimingRunResult> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Todo timing limit must be between 1 and 100");
    }
    const slaReady=Boolean((await this.database.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation),effectiveDue=slaReady?effectiveSourcingDueSql('todo'):'todo.due_at';
    const [candidates, overdueCandidates] = await Promise.all([
      this.database.query<{ todo_id: string }>(
      `SELECT todo.todo_id
       FROM rework_todos todo
       JOIN todo_policies policy ON policy.policy_key=todo.policy_key AND policy.enabled=true
       LEFT JOIN rework_orders order_record
         ON order_record.rework_order_id=COALESCE(
           NULLIF(todo.route_descriptor->>'reworkOrderId','')::uuid,
           CASE WHEN todo.entity_type='rework_order' THEN todo.entity_id::uuid END
         )
       WHERE todo.status='pending' AND (${effectiveDue}) IS NOT NULL
         AND (order_record.rework_order_id IS NULL OR order_record.status<>'deleted')
         AND (
           (todo.reminder_count<policy.max_reminders AND (
             (todo.reminder_count=0
               AND CURRENT_TIMESTAMP>=(${effectiveDue})
                 + policy.first_reminder_after_due_seconds * interval '1 second')
             OR
             (todo.reminder_count=1
               AND policy.second_reminder_after_due_seconds IS NOT NULL
               AND CURRENT_TIMESTAMP>=(${effectiveDue})
                 + policy.second_reminder_after_due_seconds * interval '1 second')
           ))
           OR
           (todo.escalated_at IS NULL
             AND CURRENT_TIMESTAMP>=(${effectiveDue})
               + policy.escalate_after_due_seconds * interval '1 second')
         )
       ORDER BY (${effectiveDue}),todo.todo_id
       LIMIT $1`,
        [limit],
      ),
      this.database.query<{
        case_id: string;
        rework_order_id: string;
        payables_handler_role_snapshot: string;
        next_follow_up_at: Date;
        operation_event_id: string;
      }>(
        `SELECT case_record.case_id,case_record.rework_order_id,
                case_record.payables_handler_role_snapshot,follow.next_follow_up_at,
                follow.operation_event_id
         FROM rework_external_responsibility_cases case_record
         JOIN rework_orders order_record ON order_record.rework_order_id=case_record.rework_order_id
         JOIN LATERAL (
           SELECT next_follow_up_at,operation_event_id
           FROM rework_external_deduction_follow_ups
           WHERE case_id=case_record.case_id AND next_follow_up_at IS NOT NULL
           ORDER BY created_at DESC,follow_up_id DESC
           LIMIT 1
         ) follow ON true
         WHERE case_record.status='deduction_follow_up'
           AND order_record.status<>'deleted'
           AND follow.next_follow_up_at<=CURRENT_TIMESTAMP
         ORDER BY follow.next_follow_up_at,case_record.case_id
         LIMIT $1`,
        [limit],
      ),
    ]);
    let reminders = 0;
    let escalations = 0;
    let escalationNotifications = 0;
    let noLongerDue = 0;
    for (const candidate of candidates.rows) {
      const scheduled = await this.schedule(actor, candidate.todo_id);
      if (!scheduled) {
        noLongerDue += 1;
      } else if (scheduled.action.kind === "reminder") {
        reminders += 1;
      } else {
        escalations += 1;
        escalationNotifications += scheduled.escalationNotificationCount;
      }
    }
    let overdueTodos = 0;
    for (const candidate of overdueCandidates.rows) {
      if (await this.createDeductionOverdue(actor, candidate)) overdueTodos += 1;
    }
    return {
      claimed: candidates.rows.length,
      overdueCandidates: overdueCandidates.rows.length,
      overdueTodos,
      reminders,
      escalations,
      escalationNotifications,
      noLongerDue,
    };
  }

  private async createDeductionOverdue(
    actor: TrustedActorContext,
    candidate: Readonly<{
      case_id: string;
      rework_order_id: string;
      payables_handler_role_snapshot: string;
      next_follow_up_at: Date;
      operation_event_id: string;
    }>,
  ): Promise<boolean> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{
        status: string;
        next_follow_up_at: Date;
        operation_event_id: string;
      }>(
        `SELECT case_record.status,follow.next_follow_up_at,follow.operation_event_id
         FROM rework_external_responsibility_cases case_record
         JOIN LATERAL (
           SELECT next_follow_up_at,operation_event_id
           FROM rework_external_deduction_follow_ups
           WHERE case_id=case_record.case_id AND next_follow_up_at IS NOT NULL
           ORDER BY created_at DESC,follow_up_id DESC
           LIMIT 1
         ) follow ON true
         WHERE case_record.case_id=$1
         FOR UPDATE`,
        [candidate.case_id],
      );
      const row = current.rows[0];
      if (!row || row.status !== "deduction_follow_up"
        || row.operation_event_id !== candidate.operation_event_id
        || row.next_follow_up_at.getTime() !== candidate.next_follow_up_at.getTime()) {
        await client.query("COMMIT");
        return false;
      }
      const deadline = row.next_follow_up_at.toISOString();
      await this.projections.actionableForUniqueRoleOrOrderDelegate(client, actor, {
        category: "external_deduction_overdue",
        sourceEventId: row.operation_event_id,
        sourceAction: "rework.external_deduction.follow_up",
        entityType: "rework_order",
        entityId: candidate.rework_order_id,
        requiredRole: candidate.payables_handler_role_snapshot,
        requiredCapability: "external_deduction:follow_up",
        delegationScopeId: candidate.rework_order_id,
        route: {
          routeName: "external_responsibility_detail",
          entityId: candidate.case_id,
          reworkOrderId: candidate.rework_order_id,
        },
        policyKey: "deduction_follow_up",
        authoritativeDueAt: row.next_follow_up_at,
        dedupeKey: `deduction-overdue:${candidate.case_id}:${deadline}`,
      });
      await client.query("COMMIT");
      return true;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async schedule(
    actor: TrustedActorContext,
    todoId: string,
  ): Promise<ScheduledTimingAction | null> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const action = await this.todos.scheduleNextTimingInTransaction(
        client,
        actor,
        todoId,
      );
      if (action?.kind === "escalation") {
        const recipients = await this.escalationRecipients(client, action);
        for (const recipientUserId of recipients) {
          if (!(await memberCanReceiveFact(client, recipientUserId, "todo.escalate", "rework_todo", action.todoId))) continue;
          await this.todos.createInTransaction(client, actor, {
            todoType: "information",
            category: "todo_escalation",
            sourceEventId: action.operationEventId,
            sourceAction: "todo.escalate",
            entityType: "rework_todo",
            entityId: action.todoId,
            recipientUserId,
            route: action.route,
            dedupeKey: `todo-escalation:${action.todoId}:${action.operationEventId}:${recipientUserId}`,
          });
        }
        await client.query("COMMIT");
        return { action, escalationNotificationCount: recipients.length };
      }
      await client.query("COMMIT");
      return action ? { action, escalationNotificationCount: 0 } : null;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async escalationRecipients(
    client: PoolClient,
    action: TimedTodoAction,
  ): Promise<string[]> {
    const ownerEscalations = new Set([
      "responsibility_determination",
      "high_multiplier_confirmation",
      "wage_administrative_review",
      "wage_month_close",
      "wage_adjustment_approval",
    ]);
    const ownFactory = action.category === "own_factory_approval";
    const requiredRole = ownerEscalations.has(action.category) || ownFactory
      ? "owner_group"
      : "production_management";
    const requiredCapability = ownFactory
      ? "own_factory:approve"
      : ownerEscalations.has(action.category)
        ? action.category.startsWith("wage_")
          ? "wage:view"
          : "responsibility:confirm_high_multiplier"
        : "todo:routing_exception_manage";
    const result = await client.query<{ user_id: string }>(
      `SELECT DISTINCT assignment.user_id
       FROM user_role_assignments assignment
       WHERE assignment.role_code=$1 AND assignment.revoked_at IS NULL
         AND ($2::uuid IS NULL OR assignment.user_id<>$2)
         AND todo_user_has_direct_role(assignment.user_id,$1,$3)
       ORDER BY assignment.user_id
       LIMIT 3`,
      [requiredRole, ownFactory ? action.recipientUserId : null, requiredCapability],
    );
    return result.rows.map((row) => row.user_id);
  }
}
