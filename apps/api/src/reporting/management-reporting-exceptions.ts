import type { ManagementDashboardResponse } from "@dx-rework/contracts/reporting";

import { TIMEZONE, type Queryable, type ExceptionRow } from "./management-reporting-shared.js";

export async function exceptions(
  limit: number,
  source: Queryable,
  filters: Readonly<{ from?: string; to?: string; q?: string; status?: string }> = {},
): Promise<ManagementDashboardResponse["exceptions"]> {
  const values: unknown[] = [];
  const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const where = ["1=1"];
  if (filters.from) where.push(`(occurred_at AT TIME ZONE '${TIMEZONE}')::date>=${bind(filters.from)}::date`);
  if (filters.to) where.push(`(occurred_at AT TIME ZONE '${TIMEZONE}')::date<=${bind(filters.to)}::date`);
  if (filters.q) { const keyword=bind(`%${filters.q}%`); where.push(`(label ILIKE ${keyword} OR entity_id ILIKE ${keyword})`); }
  if (filters.status) where.push(`exception_type=${bind(filters.status)}`);
  const limitParameter=bind(limit);
  const result = await source.query<ExceptionRow>(
    `WITH todo_order AS (
       SELECT todo.todo_id,
         CASE todo.entity_type
           WHEN 'rework_order' THEN CASE WHEN todo.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN todo.entity_id::uuid END
           WHEN 'own_factory_approval' THEN approval.rework_order_id
           WHEN 'external_responsibility_case' THEN external_case.rework_order_id
           WHEN 'responsibility_determination' THEN determination.rework_order_id
           ELSE NULL
         END rework_order_id
       FROM rework_todos todo
       LEFT JOIN rework_own_factory_approvals approval
         ON todo.entity_type='own_factory_approval' AND approval.approval_id::text=todo.entity_id
       LEFT JOIN rework_external_responsibility_cases external_case
         ON todo.entity_type='external_responsibility_case' AND external_case.case_id::text=todo.entity_id
       LEFT JOIN rework_responsibility_determinations determination
         ON todo.entity_type='responsibility_determination' AND determination.determination_id::text=todo.entity_id
     ), exceptions AS (
       SELECT 'overdue_todo'::text exception_type,todo.todo_id::text entity_id,
         mapped.rework_order_id,('待办逾期：'||todo.category)::text AS label,
         todo.due_at occurred_at,
         CASE WHEN mapped.rework_order_id IS NULL THEN '/ui/tasks' ELSE '/ui/tasks/'||mapped.rework_order_id::text END deep_link
       FROM rework_todos todo JOIN todo_order mapped USING(todo_id)
       WHERE todo.status='pending' AND todo.due_at<CURRENT_TIMESTAMP
       UNION ALL
       SELECT 'blocked_recipient',todo.todo_id::text,mapped.rework_order_id,
         ('接收人失效：'||todo.category),todo.blocked_at,
         CASE WHEN mapped.rework_order_id IS NULL THEN '/ui/tasks' ELSE '/ui/tasks/'||mapped.rework_order_id::text END
       FROM rework_todos todo JOIN todo_order mapped USING(todo_id)
       WHERE todo.status='blocked_recipient'
       UNION ALL
       SELECT 'todo_delivery_failed',binding.binding_id::text,mapped.rework_order_id,
         ('钉钉投递永久失败：'||todo.category),binding.updated_at,
         CASE WHEN mapped.rework_order_id IS NULL THEN '/ui/tasks' ELSE '/ui/tasks/'||mapped.rework_order_id::text END
       FROM dingtalk_todo_external_bindings binding
       JOIN rework_todos todo USING(todo_id) JOIN todo_order mapped USING(todo_id)
       WHERE binding.provider_state='permanent_failed'
       UNION ALL
       SELECT 'deduction_follow_up_overdue',follow_up.follow_up_id::text,case_record.rework_order_id,
         ('扣款跟进逾期：'||case_record.supplier_name_snapshot),follow_up.next_follow_up_at,
         '/ui/external-responsibilities?case='||case_record.case_id::text
       FROM rework_external_deduction_follow_ups follow_up
       JOIN rework_external_responsibility_cases case_record USING(case_id)
       WHERE follow_up.next_follow_up_at<CURRENT_TIMESTAMP
         AND case_record.status='deduction_follow_up'
         AND NOT EXISTS(
           SELECT 1 FROM rework_external_deduction_follow_ups newer
           WHERE newer.case_id=follow_up.case_id AND (newer.created_at,newer.follow_up_id)>(follow_up.created_at,follow_up.follow_up_id)
         )
     )
     SELECT exception_type,entity_id,exceptions.rework_order_id,label,occurred_at,deep_link
     FROM exceptions
     LEFT JOIN rework_orders order_record ON order_record.rework_order_id=exceptions.rework_order_id
     WHERE (exceptions.rework_order_id IS NULL OR order_record.status<>'deleted')
       AND ${where.join(" AND ")} ORDER BY occurred_at,entity_id LIMIT ${limitParameter}`,
    values,
  );
  return result.rows.map((row) => ({
    exceptionType: row.exception_type,
    entityId: row.entity_id,
    reworkOrderId: row.rework_order_id,
    label: row.label,
    occurredAt: row.occurred_at.toISOString(),
    deepLink: row.deep_link,
  }));
}
