import { type Queryable, type FactRow, TIMEZONE } from "./management-reporting-shared.js";

export async function fetchFacts(source: Queryable, options: {
  q?: string;
  status?: string;
  responsibilityType?: string;
  currentHandlerUserId?: string;
  supplierId?: string;
  overdue?: boolean;
  exception?: boolean;
  from?: string;
  to?: string;
  limit: number;
  cursor?: { updatedAt: string; id: string } | null;
  siteOnly?: boolean;
  workTaskActorUserId?: string;
  includeTemporaryProxyTasks?: boolean;
}) {
  const values: unknown[] = [];
  const bind = (value: unknown): string => { values.push(value); return `$${values.length}`; };
  const where = ["1=1"];
  if (options.q) {
    const p = bind(`%${options.q}%`);
    where.push(`(order_record.rework_no ILIKE ${p} OR order_record.style_no ILIKE ${p} OR order_record.order_no ILIKE ${p}
      OR EXISTS(SELECT 1 FROM active_cases searched_case WHERE searched_case.rework_order_id=order_record.rework_order_id AND searched_case.supplier_name_snapshot ILIKE ${p})
      OR EXISTS(SELECT 1 FROM app_users searched_user WHERE searched_user.id=COALESCE(todo_stats.current_handler,current_determination.handler_user_id,order_record.merchandiser_user_id) AND searched_user.display_name ILIKE ${p})
      OR EXISTS(
        SELECT 1 FROM rework_work_tasks searched_task
        JOIN rework_work_task_members searched_member ON searched_member.work_task_id=searched_task.work_task_id
        JOIN business_people searched_person ON searched_person.person_id=searched_member.person_id
        WHERE searched_task.rework_order_id=order_record.rework_order_id AND searched_person.display_name ILIKE ${p}
      ))`);
  }
  if (options.status) where.push(`order_record.status=${bind(options.status)}`);
  if (options.responsibilityType) where.push(`EXISTS(SELECT 1 FROM responsibility_types types WHERE types.rework_order_id=order_record.rework_order_id AND types.responsibility_type=${bind(options.responsibilityType)})`);
  if (options.currentHandlerUserId) where.push(`COALESCE(todo_stats.current_handler,current_determination.handler_user_id,order_record.merchandiser_user_id)=${bind(options.currentHandlerUserId)}::uuid`);
  if (options.supplierId) where.push(`EXISTS(SELECT 1 FROM active_cases filtered_case WHERE filtered_case.rework_order_id=order_record.rework_order_id AND filtered_case.supplier_id=${bind(options.supplierId)}::uuid)`);
  if (options.overdue !== undefined) where.push(`(CASE WHEN order_record.status='cancelled' THEN false ELSE COALESCE(todo_stats.overdue,false) OR COALESCE(followup_stats.overdue,false) END)=${bind(options.overdue)}`);
  if (options.exception !== undefined) where.push(`(CASE WHEN order_record.status='cancelled' THEN 0 ELSE COALESCE(todo_stats.exception_count,0)+COALESCE(followup_stats.exception_count,0) END)${options.exception ? ">" : "="}0`);
  if (options.from) where.push(`(order_record.created_at AT TIME ZONE '${TIMEZONE}')::date>=${bind(options.from)}::date`);
  if (options.to) where.push(`(order_record.created_at AT TIME ZONE '${TIMEZONE}')::date<=${bind(options.to)}::date`);
  if (options.cursor) {
    const date = bind(options.cursor.updatedAt);
    const id = bind(options.cursor.id);
    where.push(`(order_record.updated_at,order_record.rework_order_id)<(${date}::timestamptz,${id}::uuid)`);
  }
  if (options.siteOnly) where.push(`order_record.status IN ('pending_process_configuration','pending_ie_review','pending_task_assignment','in_progress','pending_order_review','pending_quantity_adjustment_ie_review')`);
  if (options.workTaskActorUserId || options.includeTemporaryProxyTasks) {
    const visibility: string[] = [];
    if (options.workTaskActorUserId) {
      visibility.push(`visible_person.app_user_id=${bind(options.workTaskActorUserId)}::uuid`);
    }
    if (options.includeTemporaryProxyTasks) {
      visibility.push("visible_member.person_type_snapshot='temporary'");
    }
    where.push(`EXISTS(
      SELECT 1
      FROM rework_work_tasks visible_task
      JOIN rework_work_task_members visible_member ON visible_member.work_task_id=visible_task.work_task_id
      JOIN business_people visible_person ON visible_person.person_id=visible_member.person_id
      WHERE visible_task.rework_order_id=order_record.rework_order_id
        AND visible_task.status='active'
        AND (${visibility.join(" OR ")})
    )`);
  }
  const limit = bind(options.limit);
  return source.query<FactRow>(
    `WITH current_determinations AS (
       SELECT determination.* FROM rework_responsibility_determinations determination
       WHERE NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations successor WHERE successor.replaces_determination_id=determination.determination_id)
     ), responsibility AS (
       SELECT determination.rework_order_id,
         COALESCE(sum(allocation.rounded_amount),0)::text responsibility_amount,
         COALESCE(sum(allocation.rounded_amount) FILTER(WHERE allocation.responsibility_type='own_factory'),0)::text own_factory_amount
       FROM current_determinations determination
       LEFT JOIN rework_responsibility_allocations allocation USING(determination_id)
       WHERE determination.stage='finalized' GROUP BY determination.rework_order_id
     ), responsibility_types AS (
       SELECT DISTINCT determination.rework_order_id,allocation.responsibility_type
       FROM current_determinations determination JOIN rework_responsibility_allocations allocation USING(determination_id)
       WHERE determination.stage='finalized'
     ), active_cases AS (
       SELECT case_record.* FROM current_determinations determination
       JOIN rework_external_responsibility_batches batch
         ON batch.finalized_determination_id=determination.determination_id AND batch.status='active'
       JOIN rework_external_responsibility_cases case_record USING(batch_id)
       WHERE determination.stage='finalized' AND case_record.status<>'superseded'
     ), entry_totals AS (
       SELECT case_id,COALESCE(sum(amount),0) actual FROM rework_external_deduction_entries GROUP BY case_id
     ), external AS (
       SELECT case_record.rework_order_id,
         COALESCE(sum(case_record.proposed_deduction_amount),0)::text proposed,
         COALESCE(sum(COALESCE(closure.actual_deducted_amount,entry.actual,0)),0)::text deducted,
         COALESCE(sum(COALESCE(closure.remaining_amount,case_record.proposed_deduction_amount-COALESCE(entry.actual,0))),0)::text remaining
       FROM active_cases case_record LEFT JOIN entry_totals entry USING(case_id)
       LEFT JOIN rework_external_deduction_closures closure USING(case_id)
       GROUP BY case_record.rework_order_id
     ), approved_adjustments AS (
       SELECT original_wage_item_id,sum(adjustment_amount) adjustment
       FROM rework_wage_adjustments WHERE status='approved' GROUP BY original_wage_item_id
     ), wages AS (
       SELECT wage.rework_order_id,
         COALESCE(sum(wage.payable_amount+COALESCE(adjustment.adjustment,0)),0)::text wage_amount
       FROM rework_wage_items wage LEFT JOIN approved_adjustments adjustment ON adjustment.original_wage_item_id=wage.wage_item_id
       GROUP BY wage.rework_order_id
     ), reports AS (
       SELECT report.rework_order_id,COALESCE(sum(report.actual_quantity),0)::text reported_quantity
       FROM rework_work_reports report
       WHERE NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
       GROUP BY report.rework_order_id
     ), todo_order AS (
       SELECT todo.todo_id,todo.recipient_user_id,todo.status,todo.due_at,
         CASE todo.entity_type
           WHEN 'rework_order' THEN CASE WHEN todo.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN todo.entity_id::uuid END
           WHEN 'own_factory_approval' THEN approval.rework_order_id
           WHEN 'external_responsibility_case' THEN external_case.rework_order_id
           WHEN 'responsibility_determination' THEN determination.rework_order_id
           ELSE NULL
         END rework_order_id
       FROM rework_todos todo
       LEFT JOIN rework_own_factory_approvals approval ON todo.entity_type='own_factory_approval' AND approval.approval_id::text=todo.entity_id
       LEFT JOIN rework_external_responsibility_cases external_case ON todo.entity_type='external_responsibility_case' AND external_case.case_id::text=todo.entity_id
       LEFT JOIN rework_responsibility_determinations determination ON todo.entity_type='responsibility_determination' AND determination.determination_id::text=todo.entity_id
     ), todo_stats AS (
       SELECT mapped.rework_order_id,
         bool_or(mapped.status='pending' AND mapped.due_at<CURRENT_TIMESTAMP) overdue,
         count(*) FILTER(WHERE mapped.status='blocked_recipient')::int
           + count(*) FILTER(WHERE binding.provider_state='permanent_failed')::int exception_count,
         (array_agg(mapped.recipient_user_id ORDER BY mapped.due_at NULLS LAST,mapped.todo_id) FILTER(WHERE mapped.status IN ('pending','blocked_recipient')))[1] current_handler
       FROM todo_order mapped LEFT JOIN dingtalk_todo_external_bindings binding ON binding.todo_id=mapped.todo_id
       WHERE mapped.rework_order_id IS NOT NULL GROUP BY mapped.rework_order_id
     ), latest_follow_up AS (
       SELECT DISTINCT ON (follow_up.case_id) follow_up.case_id,follow_up.next_follow_up_at
       FROM rework_external_deduction_follow_ups follow_up ORDER BY follow_up.case_id,follow_up.created_at DESC,follow_up.follow_up_id DESC
     ), followup_stats AS (
       SELECT case_record.rework_order_id,
         bool_or(follow_up.next_follow_up_at<CURRENT_TIMESTAMP AND case_record.status='deduction_follow_up') overdue,
         count(*) FILTER(WHERE follow_up.next_follow_up_at<CURRENT_TIMESTAMP AND case_record.status='deduction_follow_up')::int exception_count
       FROM active_cases case_record LEFT JOIN latest_follow_up follow_up USING(case_id)
       GROUP BY case_record.rework_order_id
     ), latest_event AS (
       SELECT DISTINCT ON (entity_id) entity_id::uuid rework_order_id,created_at
       FROM operation_events WHERE entity_type='rework_order'
         AND entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' AND action LIKE 'rework.%'
         AND before_state->>'status' IS DISTINCT FROM after_state->>'status'
       ORDER BY entity_id,created_at DESC,event_id DESC
     )
     SELECT order_record.rework_order_id,order_record.rework_no,order_record.style_no,order_record.order_no,
       order_record.status,
       CASE order_record.status
         WHEN 'draft' THEN 'N00' WHEN 'pending_process_configuration' THEN 'N02'
         WHEN 'pending_ie_review' THEN 'N03' WHEN 'pending_task_assignment' THEN 'N04'
         WHEN 'in_progress' THEN 'N05' WHEN 'pending_order_review' THEN 'N06'
         WHEN 'pending_quantity_adjustment_ie_review' THEN 'N06-A'
         WHEN 'pending_responsibility_determination' THEN 'N07'
         WHEN 'pending_responsibility_action' THEN 'N08'
         WHEN 'completed' THEN 'N09' ELSE 'N-C' END node,
       CASE order_record.status
         WHEN 'draft' THEN '草稿' WHEN 'pending_process_configuration' THEN '待配置工序'
         WHEN 'pending_ie_review' THEN '待 IE 审核' WHEN 'pending_task_assignment' THEN '待分配人员'
         WHEN 'in_progress' THEN '返工执行中' WHEN 'pending_order_review' THEN '待整单审核'
         WHEN 'pending_quantity_adjustment_ie_review' THEN '数量调整待 IE'
         WHEN 'pending_responsibility_determination' THEN '待责任判定'
         WHEN 'pending_responsibility_action' THEN '责任分支处理中'
         WHEN 'completed' THEN '生产返工已完成' ELSE '已取消' END node_label,
       COALESCE(latest_event.created_at,order_record.updated_at) node_entered_at,
       (CASE WHEN order_record.status IN ('completed','cancelled') THEN 0
         ELSE greatest(0,extract(epoch FROM CURRENT_TIMESTAMP-COALESCE(latest_event.created_at,order_record.updated_at))) END)::bigint::text aging_seconds,
       COALESCE(todo_stats.current_handler,current_determination.handler_user_id,order_record.merchandiser_user_id) current_handler_user_id,
       order_record.rework_quantity::text planned_quantity,COALESCE(reports.reported_quantity,'0') reported_quantity,
       COALESCE(wages.wage_amount,'0') wage_amount,COALESCE(responsibility.responsibility_amount,'0') responsibility_amount,
       COALESCE(responsibility.own_factory_amount,'0') own_factory_amount,COALESCE(external.proposed,'0') external_proposed_amount,
       COALESCE(external.deducted,'0') external_deducted_amount,COALESCE(external.remaining,'0') external_remaining_amount,
       CASE WHEN order_record.status='cancelled' THEN false
         ELSE COALESCE(todo_stats.overdue,false) OR COALESCE(followup_stats.overdue,false) END overdue,
       CASE WHEN order_record.status='cancelled' THEN 0
         ELSE COALESCE(todo_stats.exception_count,0)+COALESCE(followup_stats.exception_count,0) END exception_count,
       order_record.updated_at
     FROM rework_orders order_record
     LEFT JOIN current_determinations current_determination ON current_determination.rework_order_id=order_record.rework_order_id
     LEFT JOIN responsibility ON responsibility.rework_order_id=order_record.rework_order_id
     LEFT JOIN external ON external.rework_order_id=order_record.rework_order_id
     LEFT JOIN wages ON wages.rework_order_id=order_record.rework_order_id
     LEFT JOIN reports ON reports.rework_order_id=order_record.rework_order_id
     LEFT JOIN todo_stats ON todo_stats.rework_order_id=order_record.rework_order_id
     LEFT JOIN followup_stats ON followup_stats.rework_order_id=order_record.rework_order_id
     LEFT JOIN latest_event ON latest_event.rework_order_id=order_record.rework_order_id
     WHERE ${where.join(" AND ")}
     ORDER BY order_record.updated_at DESC,order_record.rework_order_id DESC LIMIT ${limit}`,
    values,
  );
}
