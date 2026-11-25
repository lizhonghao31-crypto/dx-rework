import type {PoolClient} from 'pg';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {readDevelopmentOrderRush} from './development-order-rush.js';
import {readTaskAccessForPage} from './journey-selection-access.js';
import {originalMerchandiserTaskKind,originalMerchandiserTaskKinds,type AuthorizedMerchandiserWorkItem} from './merchandiser-work-candidates.js';

const collaboratingTasks={bulk_pattern:'preparation',warehouse_preshrink:'preparation',warehouse_dispatch:'delivery',
 bulk_qc:'exceptions',process_logistics:'delivery'} as const;
type NativeTask={task_id:string;task_kind:string;order_id:string;source_id:string|null;style_no:string|null;customer:string|null;
 label:string;handler:string|null;due_at:Date|null;po_numbers:string[]};

/** Read-only original progress, never a synthetic todo or a grant to handle
 * another participant's task. Only a ready, staffed task counts as waiting;
 * only a persisted completion by this assigned merchandiser counts as done. */
export async function readMerchandiserTaskProgress(db:PoolClient,actor:TrustedActorContext,state:'waiting'|'completed'){
 const scene=acceptanceBusinessContext()?.scenarioId??null;
 const rows=(await db.query<NativeTask>(`SELECT t.task_id,a.task_kind,o.production_order_id AS order_id,o.source_id,
    o.design_style_no AS style_no,o.customer_code AS customer,person.display_name AS handler,
    coalesce(nullif(d.sla_basis->>'craftLabel',''),p.label) AS label,d.due_at,
    ARRAY(SELECT po.po_number FROM digital_production_po_lines po WHERE po.production_order_id=o.production_order_id AND po.po_number IS NOT NULL ORDER BY po.position,po.line_id) AS po_numbers
   FROM digital_production_orders o JOIN digital_production_task_access a USING(production_order_id)
   JOIN digital_production_tasks t USING(task_id)
   JOIN app_users person ON person.id=a.assignee_id
   JOIN LATERAL (SELECT label FROM digital_production_deadline_policies p WHERE p.node_key=t.node_key ORDER BY version DESC LIMIT 1) p ON true
   LEFT JOIN LATERAL (SELECT r.due_at,r.sla_basis FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id ORDER BY r.revision_id DESC LIMIT 1) d ON true
   WHERE a.task_kind=ANY($2::text[]) AND t.state=$3
    AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM acceptance_sla_clock_resources scene WHERE scene.scenario_id=$4 AND scene.resource_kind='order' AND scene.resource_id=o.production_order_id))
    AND CASE WHEN $3='completed' THEN a.assignee_id=$1 AND a.required_role='order_merchandiser' AND EXISTS(
      SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='completed' AND e.actor_id=$1
    ) ELSE a.assignee_id<>$1 AND (o.primary_merchandiser_id=$1 OR EXISTS(SELECT 1 FROM digital_order_secondary_merchandisers s WHERE s.production_order_id=o.production_order_id AND s.user_id=$1))
      AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l WHERE l.state<>'active' AND
        (l.resource_kind='order' AND l.resource_id=o.production_order_id OR l.resource_kind='source' AND l.resource_id=o.source_id))
      AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)
      AND person.enabled AND NOT person.manual_access_disabled
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=person.id AND i.active AND i.employed)
      AND EXISTS(SELECT 1 FROM user_role_assignments r JOIN business_roles b USING(role_code) WHERE r.user_id=person.id AND r.revoked_at IS NULL
        AND b.enabled AND (r.role_code=a.required_role OR a.required_role='warehouse_receiver' AND r.role_code='warehouse_supervisor')) END`,
 [actor.actorId,state==='waiting'?Object.keys(collaboratingTasks):originalMerchandiserTaskKinds,state==='waiting'?'ready':'completed',scene])).rows;
 const native=await readTaskAccessForPage(db,actor,rows.map(row=>row.task_id));
 const visible=rows.filter(row=>native.get(row.task_id)?.technical&&native.get(row.task_id)?.parentTechnical);
 const rush=await readDevelopmentOrderRush(db,visible.map(row=>({orderId:row.order_id,sourceId:row.source_id})));
 return visible.flatMap((row):AuthorizedMerchandiserWorkItem[]=>{
  const kind=state==='completed'?originalMerchandiserTaskKind(row.task_kind):collaboratingTasks[row.task_kind as keyof typeof collaboratingTasks];
  return kind?[{itemId:row.task_id,state,kind,title:row.label,route:{routeName:'digital_production_task',entityId:row.task_id,todoId:row.task_id},
   dueAt:row.due_at?.toISOString()??null,orderNumber:row.style_no,styleNo:row.style_no,customer:row.customer,poNumbers:row.po_numbers,
   factory:null,urgent:rush.has('order:'+row.order_id),responsibleName:row.handler}]:[];
 });
}
