import type { PoolClient } from 'pg';
import type { SlaNodeFact } from '@dx-rework/domain/digital-sla-plan';
import { effectiveSourcingDueSql } from './sla-sourcing-deadline-sql.js';
/** Same original todo deadlines and native business transitions as the sourcing work area. */
export async function sourcingSlaEvidence(db: Pick<PoolClient, 'query'>, orderId: string) {
    const facts: Record<string, SlaNodeFact> = {};
    if (!(await db.query("SELECT to_regclass('sourcing_cases') AS relation")).rows[0]?.relation)
        return facts;
    const rows = (await db.query(`SELECT DISTINCT ON(t.entity_id,t.category) t.entity_id,t.category,t.status,${effectiveSourcingDueSql('t')} AS effective_due,
   first_window.started_at,done.business_at AS completed_at,done.operation_event_id,
   CASE t.category WHEN 'sourcing_ie_quote' THEN 'sourcing_ie' WHEN 'sourcing_management_decision' THEN 'sourcing_selection' ELSE 'sourcing_approval' END AS parameter
 FROM rework_todos t
 JOIN digital_production_child_links link ON link.module='sourcing' AND link.child_id::text=t.entity_id AND link.production_order_id=$1
 LEFT JOIN LATERAL(SELECT original.due_at-make_interval(secs=>((snapshot.parameters_json->(CASE original.category WHEN 'sourcing_ie_quote' THEN 'sourcing_ie' WHEN 'sourcing_management_decision' THEN 'sourcing_selection' ELSE 'sourcing_approval' END)->'value'->>'minutes')::numeric*60)::double precision) AS started_at
   FROM rework_todos original LEFT JOIN operation_events creation ON creation.event_id=original.created_operation_event_id AND creation.action='todo.create'
   LEFT JOIN digital_sla_order_snapshots snapshot ON snapshot.snapshot_id::text=creation.after_state->'slaTiming'->>'snapshotId' AND snapshot.production_order_id=$1
   WHERE original.entity_type='sourcing_case' AND original.entity_id=t.entity_id AND original.category=t.category AND original.todo_type='business_action'
   ORDER BY original.created_at,original.todo_id LIMIT 1) first_window ON true
 LEFT JOIN LATERAL(SELECT transition.operation_event_id,coalesce((event.after_state->'acceptanceClock'->>'now')::timestamptz,transition.transitioned_at) AS business_at
   FROM sourcing_case_transitions transition JOIN operation_events event ON event.event_id=transition.operation_event_id
   WHERE transition.sourcing_case_id::text=t.entity_id AND transition.business_action=ANY(CASE t.category WHEN 'sourcing_ie_quote' THEN ARRAY['ie_price_quoted'] WHEN 'sourcing_management_decision' THEN ARRAY['management_decision_recorded'] ELSE ARRAY['owner_approved','owner_rejected'] END)
   ORDER BY transition.sequence DESC LIMIT 1) done ON true
 WHERE t.entity_type='sourcing_case' AND t.todo_type='business_action' AND t.category IN ('sourcing_ie_quote','sourcing_management_decision','sourcing_owner_approval')
 ORDER BY t.entity_id,t.category,t.created_at DESC,t.todo_id DESC`, [orderId])).rows;
    for (const row of rows) {
        const complete = row.status === 'completed' && !!row.completed_at, started = row.started_at ? new Date(row.started_at).toISOString() : null, due = row.effective_due ? new Date(row.effective_due).toISOString() : null;
        facts[row.parameter] = { evidence: `sourcing:${row.entity_id}:${row.category}${row.operation_event_id ? `;event:${row.operation_event_id}` : ''}`, businessCompleted: complete,
            ...(started ? { startedAt: started } : {}), ...(started && due ? { standardMinutes: (Date.parse(due) - Date.parse(started)) / 60000 } : {}),
            ...(complete ? { completedAt: new Date(row.completed_at).toISOString(), completedDeadline: { at: due, exclusive: false, reasons: due ? [] : ['原商务待办缺少可信起点'] } } : {}) };
    }
    return facts;
}
