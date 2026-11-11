/** Read projection only. The original immutable todo deadline and reminder counters remain untouched. */
export function sourcingAppliedDeadlineSql(alias: string) {
    if (!/^[a-z_]+$/.test(alias))
        throw new Error('Invalid SQL alias');
    const parameter = `CASE ${alias}.category WHEN 'sourcing_ie_quote' THEN 'sourcing_ie' WHEN 'sourcing_management_decision' THEN 'sourcing_selection' WHEN 'sourcing_owner_approval' THEN 'sourcing_approval' END`;
    return `(SELECT jsonb_build_object('snapshotId',snapshot.snapshot_id,'warningPercent',(snapshot.parameters_json->'warning_ratio'->'value'->>'percent')::int,'dueAt',
   CASE WHEN first_transition.started_at IS NULL THEN NULL ELSE first_transition.started_at+
     make_interval(secs=>((snapshot.parameters_json->(${parameter})->'value'->>'minutes')::numeric*60)::double precision) END)
 FROM digital_production_child_links link
 JOIN digital_production_task_events application ON application.resource_kind='order' AND application.resource_id=link.production_order_id AND application.event_kind='sla_standard_applied'
 JOIN digital_sla_order_snapshots snapshot ON snapshot.snapshot_id::text=application.payload->>'snapshotId' AND snapshot.production_order_id=link.production_order_id
 LEFT JOIN LATERAL(SELECT original.due_at-make_interval(secs=>((basis.parameters_json->(${parameter})->'value'->>'minutes')::numeric*60)::double precision) AS started_at FROM rework_todos original
   LEFT JOIN operation_events creation ON creation.event_id=original.created_operation_event_id AND creation.action='todo.create'
   LEFT JOIN digital_sla_order_snapshots basis ON basis.snapshot_id::text=creation.after_state->'slaTiming'->>'snapshotId' AND basis.production_order_id=link.production_order_id
   WHERE original.entity_type='sourcing_case' AND original.entity_id=${alias}.entity_id AND original.category=${alias}.category AND original.todo_type='business_action'
   ORDER BY original.created_at,original.todo_id LIMIT 1) first_transition ON true
 WHERE ${alias}.entity_type='sourcing_case' AND link.module='sourcing' AND link.child_id::text=${alias}.entity_id
   AND NOT EXISTS(SELECT 1 FROM operation_events own_window WHERE own_window.event_id=${alias}.created_operation_event_id AND own_window.after_state->'slaTiming'->'orderTime'->>'version'='1')
   AND ((application.payload->'parameterKeys' ? (${parameter})) OR (application.payload->'parameterKeys' ? 'warning_ratio'))
   AND NOT(application.payload->'completedWindows' ? ('sourcing:'||${alias}.entity_id||':'||${alias}.category))
 ORDER BY snapshot.revision DESC LIMIT 1)`;
}
export function effectiveSourcingDueSql(alias: string) { const applied = sourcingAppliedDeadlineSql(alias); return `CASE WHEN ${applied} IS NOT NULL THEN (${applied}->>'dueAt')::timestamptz ELSE ${alias}.due_at END`; }
