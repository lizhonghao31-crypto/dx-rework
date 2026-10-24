/** Read projection only. The original immutable todo deadline and reminder counters remain untouched. */
export function sourcingAppliedDeadlineSql(alias:string){
 if(!/^[a-z_]+$/.test(alias))throw new Error('Invalid SQL alias');
 const parameter=`CASE ${alias}.category WHEN 'sourcing_ie_quote' THEN 'sourcing_ie' WHEN 'sourcing_management_decision' THEN 'sourcing_selection' WHEN 'sourcing_owner_approval' THEN 'sourcing_approval' END`;
 return `(SELECT jsonb_build_object('snapshotId',snapshot.snapshot_id,'dueAt',
   CASE WHEN first_transition.transitioned_at IS NULL THEN NULL ELSE first_transition.transitioned_at+
     make_interval(secs=>((snapshot.parameters_json->(${parameter})->'value'->>'minutes')::numeric*60)::double precision) END)
 FROM digital_production_child_links link
 JOIN digital_production_task_events application ON application.resource_kind='order' AND application.resource_id=link.production_order_id AND application.event_kind='sla_standard_applied'
 JOIN digital_sla_order_snapshots snapshot ON snapshot.snapshot_id::text=application.payload->>'snapshotId'
 LEFT JOIN LATERAL(SELECT transition.transitioned_at FROM rework_todos original
   LEFT JOIN sourcing_case_transitions transition ON transition.sourcing_case_id::text=original.entity_id AND transition.operation_event_id=original.source_event_id
   WHERE original.entity_type='sourcing_case' AND original.entity_id=${alias}.entity_id AND original.category=${alias}.category AND original.todo_type='business_action'
   ORDER BY original.created_at,original.todo_id LIMIT 1) first_transition ON true
 WHERE ${alias}.entity_type='sourcing_case' AND link.module='sourcing' AND link.child_id::text=${alias}.entity_id
   AND (application.payload->'parameterKeys' ? (${parameter}))
   AND NOT(application.payload->'completedWindows' ? ('sourcing:'||${alias}.entity_id||':'||${alias}.category))
 ORDER BY snapshot.revision DESC LIMIT 1)`;
}
export function effectiveSourcingDueSql(alias:string){const applied=sourcingAppliedDeadlineSql(alias);return `CASE WHEN ${applied} IS NOT NULL THEN (${applied}->>'dueAt')::timestamptz ELSE ${alias}.due_at END`;}
