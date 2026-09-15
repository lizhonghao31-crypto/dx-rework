import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { TodoService, type CreateTodoInTransactionInput } from "../todos/service.js";

export type MemberBindings = Readonly<{ li_zhonghao: string; wu_yunfeng: string; li_junyue: string }>;
type PendingTodo = {
  todo_id: string; dedupe_key: string; source_event_id: string; source_action: string;
  entity_type: string; entity_id: string; category: string; todo_type: string;
  required_role: string | null; required_capability: string | null;
  route_descriptor: CreateTodoInTransactionInput["route"]; due_at: Date | null;
  policy_key: CreateTodoInTransactionInput["policyKey"]; delegation_scope_id: string | null;
};

/** One finite, Root-audited cutover. No name matching, role grants or generic policy editor. */
export class MemberModuleBindingService {
  constructor(private readonly database: Pool, private readonly todos = new TodoService(database)) {}

  async run(actorUserId: string, bindings: MemberBindings, apply = false) {
    const ids = Object.values(bindings);
    if (new Set(ids).size !== 3 || ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
      throw new ApplicationError("VALIDATION_ERROR", "必须提供三名不同成员经核实的内部用户编号", 400);
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('member-module-owner-bindings',0))");
      const root = await client.query<{ allowed: boolean }>("SELECT access_is_root_actor($1::uuid) allowed", [actorUserId]);
      if (!root.rows[0]?.allowed) throw new ApplicationError("FORBIDDEN", "仅现有 Root 可绑定已核实成员", 403);
      const members = await client.query<{ id: string; display_name: string; is_root: boolean; is_owner: boolean; identities: string }>(
        `SELECT u.id,u.display_name,access_is_root_actor(u.id) is_root,
          EXISTS(SELECT 1 FROM user_role_assignments a JOIN business_roles r USING(role_code)
            WHERE a.user_id=u.id AND a.role_code='owner_group' AND a.revoked_at IS NULL AND r.enabled) is_owner,
          (SELECT count(*) FROM identity_mappings i JOIN access_security_policy p
            ON p.policy_key='primary' AND p.dingtalk_corp_id=i.corp_id
            WHERE i.user_id=u.id AND i.provider='dingtalk' AND i.active AND i.employed) identities
         FROM app_users u WHERE u.id=ANY($1::uuid[]) AND u.enabled AND NOT u.manual_access_disabled FOR UPDATE`, [ids],
      );
      if (members.rows.length !== 3 || members.rows.some(row => Number(row.identities) !== 1
        || (row.id === bindings.li_junyue ? !row.is_root : !row.is_owner || row.is_root))) {
        throw new ApplicationError("CONFLICT", "成员必须唯一绑定有效主组织身份；李俊岳应为现有 Root，另外两人应有有效老板角色", 409);
      }
      const existing = await client.query<{ member_key: keyof MemberBindings; user_id: string }>("SELECT member_key,user_id FROM business_module_owner_bindings ORDER BY member_key");
      if (existing.rows.length && (existing.rows.length !== 3 || existing.rows.some(row => bindings[row.member_key] !== row.user_id))) {
        throw new ApplicationError("CONFLICT", "已有不同成员绑定，禁止自动覆盖，请单独核验修复", 409);
      }
      const pending = await client.query<PendingTodo>(
        `SELECT * FROM rework_todos WHERE recipient_user_id=$1 AND status IN ('pending','blocked_recipient')
          AND member_module_for_todo_fact(source_action,entity_type,entity_id) IN ('rework','sourcing')
          ORDER BY created_at,todo_id FOR UPDATE`, [bindings.wu_yunfeng],
      );
      const outbox = await client.query<{ count: string }>(
        `SELECT count(*) FROM message_outbox o JOIN rework_todos t ON t.todo_id::text=o.aggregate_id
         WHERE t.recipient_user_id=$1 AND member_module_for_todo_fact(t.source_action,t.entity_type,t.entity_id) IN ('rework','sourcing')
           AND o.status IN ('pending','processing','failed') AND o.payload->>'deliveryKind' IS DISTINCT FROM 'complete'`, [bindings.wu_yunfeng],
      );
      const report = { mode: apply ? "apply" : "dry_run", members: members.rows, alreadyBound: existing.rows.length === 3,
        pendingTodoIds: pending.rows.map(row => row.todo_id), unsentNotifications: Number(outbox.rows[0]?.count ?? 0), cancelled: 0, ownerTasksEnsured: 0 };
      if (!apply) { await client.query("ROLLBACK"); return report; }
      const actor: TrustedActorContext = { actorId: actorUserId, actorRoles: ["root_superuser"], authorizationCapability: "master_data:manage", requestId: randomUUID() };
      if (!existing.rows.length) {
        const eventId = await new OperationEventRepository().append(client, actor, {
          action: "access.member_module.bind", entityType: "business_module_owner_bindings", entityId: "0915",
          after: bindings, reason: "经人工核对稳定账号，启用返工及外发老板成员分权",
        });
        for (const [key, userId] of Object.entries(bindings)) {
          await client.query("INSERT INTO business_module_owner_bindings(member_key,user_id,operation_event_id) VALUES($1,$2,$3)", [key, userId, eventId]);
        }
      }
      for (const todo of pending.rows) {
        // Preserve the original business event and ordinary shared-completion prefix.
        // Reuse an existing recipient task rather than create a second approval.
        if (todo.todo_type === "business_action" && todo.required_role === "owner_group" && todo.required_capability && await this.approvalStillPending(client, todo)) {
          const sourceActor = await client.query<{ actor_id: string }>("SELECT actor_id FROM operation_events WHERE event_id=$1", [todo.source_event_id]);
          for (const recipient of [bindings.li_zhonghao, bindings.li_junyue]) {
            if (todo.category === "high_multiplier_confirmation" && recipient === sourceActor.rows[0]?.actor_id && recipient !== bindings.li_junyue) continue;
            const eligible = await client.query<{ allowed: boolean }>("SELECT todo_user_has_direct_role($1::uuid,'owner_group',$2) allowed", [recipient, todo.required_capability]);
            if (!eligible.rows[0]?.allowed) continue;
            const twin = await client.query("SELECT todo_id FROM rework_todos WHERE source_event_id=$1 AND category=$2 AND recipient_user_id=$3 AND status IN ('pending','blocked_recipient','completed')", [todo.source_event_id, todo.category, recipient]);
            if (twin.rows.length) continue;
            const dedupeKey = todo.dedupe_key.includes(bindings.wu_yunfeng)
              ? todo.dedupe_key.replace(bindings.wu_yunfeng, recipient) : `${todo.dedupe_key}:${recipient}`;
            await this.todos.createInTransaction(client, actor, {
              todoType: "business_action", category: todo.category, sourceEventId: todo.source_event_id,
              sourceAction: todo.source_action, entityType: todo.entity_type, entityId: todo.entity_id,
              recipientUserId: recipient, requiredRole: "owner_group", requiredCapability: todo.required_capability,
              route: todo.route_descriptor, dedupeKey,
              ...(todo.policy_key ? { policyKey: todo.policy_key } : {}),
              ...(todo.delegation_scope_id ? { delegationScopeId: todo.delegation_scope_id } : {}),
              ...(todo.due_at ? { authoritativeDueAt: todo.due_at } : {}),
            });
            report.ownerTasksEnsured += 1;
          }
        }
        if (await this.todos.cancelOpenByDedupeKey(client, actor, todo.dedupe_key, "成员模块权限调整：伍云峰在返工及外发只读，不再接收待办")) report.cancelled += 1;
      }
      // Normal delivery revalidates cancelled/blocked recipients and suppresses queued sends;
      // the cancellation above emits the existing terminal DingTalk update (never a new task).
      await client.query("COMMIT");
      return report;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }
  private async approvalStillPending(client: PoolClient, todo: PendingTodo): Promise<boolean> {
    const result = await client.query<{ pending: boolean }>(
      `SELECT CASE $1::text
       WHEN 'owner_signature' THEN EXISTS (
         SELECT 1 FROM rework_orders o JOIN rework_responsibility_determinations d USING(rework_order_id)
         WHERE o.rework_order_id::text=$2 AND o.status='pending_owner_signature' AND d.stage='finalized'
           AND d.operation_event_id=$3::uuid AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations n WHERE n.replaces_determination_id=d.determination_id))
       WHEN 'high_multiplier_confirmation' THEN EXISTS (
         SELECT 1 FROM rework_orders o JOIN rework_responsibility_determinations d USING(rework_order_id)
         WHERE o.rework_order_id::text=$2 AND o.status IN ('pending_responsibility_determination','pending_responsibility_action')
           AND d.stage='draft' AND d.operation_event_id=$3::uuid
           AND NOT EXISTS(SELECT 1 FROM rework_responsibility_high_multiplier_confirmations c WHERE c.determination_id=d.determination_id)
           AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations n WHERE n.replaces_determination_id=d.determination_id))
       WHEN 'own_factory_approval' THEN EXISTS (
         SELECT 1 FROM rework_own_factory_approvals a JOIN rework_orders o USING(rework_order_id)
         WHERE a.created_operation_event_id=$3::uuid AND a.status='pending' AND o.status<>'deleted')
       WHEN 'sourcing_owner_approval' THEN EXISTS (
         SELECT 1 FROM sourcing_cases c WHERE c.sourcing_case_id::text=$2 AND c.deleted_at IS NULL
           AND sourcing_current_status(c.sourcing_case_id)='pending_owner_approval'
           AND EXISTS(SELECT 1 FROM sourcing_case_transitions t WHERE t.sourcing_case_id=c.sourcing_case_id
             AND t.operation_event_id=$3::uuid AND t.sequence=(SELECT max(n.sequence) FROM sourcing_case_transitions n WHERE n.sourcing_case_id=c.sourcing_case_id)))
       WHEN 'sourcing_factory_change_owner_approve' THEN EXISTS (
         SELECT 1 FROM sourcing_factory_change_requests f JOIN sourcing_cases c USING(sourcing_case_id)
         WHERE c.deleted_at IS NULL AND position(f.factory_change_request_id::text IN $4::text)>0 AND f.requires_owner_approval
           AND (f.initiator_role<>'order_merchandiser' OR EXISTS(SELECT 1 FROM sourcing_factory_change_decisions d WHERE d.factory_change_request_id=f.factory_change_request_id AND d.decision_role='production_management' AND d.decision='approved'))
           AND NOT EXISTS(SELECT 1 FROM sourcing_factory_change_decisions d WHERE d.factory_change_request_id=f.factory_change_request_id AND (d.decision_role='owner_group' OR d.decision='rejected'))
           AND NOT EXISTS(SELECT 1 FROM sourcing_decisions d WHERE d.source_change_request_id=f.factory_change_request_id))
       ELSE false END pending`, [todo.category, todo.entity_id, todo.source_event_id, todo.dedupe_key],
    );
    return result.rows[0]?.pending === true;
  }

}
