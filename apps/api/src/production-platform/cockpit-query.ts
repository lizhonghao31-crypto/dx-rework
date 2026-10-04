import { OrderClosureService } from "./order-closure-service.js";
import { bulkCockpitProgress } from "./cockpit-progress.js";
import type { Pool } from "pg";
import type { CockpitResult, CockpitRow, CockpitStage } from "@dx-rework/contracts/digital-production-cockpit";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, isDigitalLeader } from "./access-policy.js";
import { assertIdentityActor, digitalDateText } from "./identity-service.js";
import { DigitalProductionTaskService } from "./task-service.js";

/** Read-only projection. Resource authorization is identical to original-page access. */
export class DigitalCockpitQuery {
  constructor(private readonly database: Pool) {}
  async list(actor: TrustedActorContext, input: { page: number; search: string; stage: CockpitStage; workload?: "all"|"unassigned"|"blocked"|"urgent" }): Promise<CockpitResult> {
    assertIdentityActor(actor);
    const db = this.database;
    const candidates = (await db.query(`SELECT o.production_order_id AS "orderId",s.source_id AS "sourceId",
      coalesce(o.production_order_id,s.source_id) AS id,coalesce(o.design_style_no,s.design_style_no) AS "styleNo",
      coalesce(o.customer_code,s.customer_code,'未指定客户') AS customer,coalesce(o.product_group,'未指定品类') AS category,
      u.display_name AS designer,m.display_name AS merchandiser,o.contract_delivery_date AS "deliveryDate",coalesce(o.created_at,s.created_at) AS "createdAt"
      FROM digital_production_sources s FULL JOIN digital_production_orders o ON o.source_id=s.source_id
      JOIN app_users u ON u.id=coalesce(o.created_by,s.created_by) LEFT JOIN app_users m ON m.id=o.primary_merchandiser_id
      WHERE ($1='development' AND s.source_id IS NOT NULL OR $1='bulk' AND o.production_order_id IS NOT NULL)
      AND ($2='' OR strpos(lower(coalesce(o.design_style_no,s.design_style_no)),lower($2))>0
        OR strpos(lower(coalesce(o.customer_code,s.customer_code,'')),lower($2))>0
        OR EXISTS(SELECT 1 FROM digital_production_po_lines l WHERE l.production_order_id=o.production_order_id AND strpos(lower(coalesce(l.po_number,'')),lower($2))>0))
      AND ($3='all' OR EXISTS(SELECT 1 FROM digital_production_task_access qa JOIN digital_production_tasks qt USING(task_id)
        WHERE (($1='development' AND qa.source_id=s.source_id) OR ($1='bulk' AND qa.production_order_id=o.production_order_id))
        AND qt.state NOT IN ('completed','cancelled') AND (($3='unassigned' AND qa.assignee_id IS NULL) OR ($3='blocked' AND qt.state='blocked')
        OR ($3='urgent' AND (SELECT e.payload->>'priority' FROM digital_production_task_events e WHERE e.task_id=qt.task_id AND e.event_kind='priority_changed' ORDER BY e.recorded_at DESC,e.event_id DESC LIMIT 1)='urgent'))))
      ORDER BY coalesce(o.created_at,s.created_at) DESC,coalesce(o.production_order_id,s.source_id) DESC`, [input.stage,input.search,input.workload??"all"])).rows;
    const policy = new DigitalProductionAccessPolicy(db);
    const visible = [];
    const clerk = actor.actorRoles.includes("development_clerk") && await policy.activeRole(actor.actorId,"development_clerk");
    for (const row of candidates) {
      const kind = input.stage === "development" ? "source" : "order";
      if (await policy.allowed(actor,kind,kind === "source" ? row.sourceId : row.orderId,"technical") || (clerk && kind === "source" && (await db.query("SELECT 1 FROM digital_production_task_access WHERE source_id=$1 AND task_kind LIKE 'development_%' LIMIT 1",[row.sourceId])).rowCount)) visible.push(row);
    }
    const ids = visible.map(row => input.stage === "development" ? row.sourceId : row.orderId);
    const column = input.stage === "development" ? "source_id" : "production_order_id";
    const summary = (await db.query(`SELECT count(DISTINCT a.${column}) FILTER(WHERE t.state NOT IN ('completed','cancelled'))::int AS active,
      count(DISTINCT a.${column}) FILTER(WHERE t.state='blocked')::int AS blocked,
      count(DISTINCT a.${column}) FILTER(WHERE t.state IN ('ready','blocked') AND r.due_at<=CURRENT_TIMESTAMP)::int AS overdue,
      count(DISTINCT a.${column}) FILTER(WHERE t.state IN ('ready','blocked') AND r.warning_at<=CURRENT_TIMESTAMP AND r.due_at>CURRENT_TIMESTAMP)::int AS "dueSoon",
      count(DISTINCT a.${column}) FILTER(WHERE t.state IN ('ready','blocked') AND t.entered_at IS NULL)::int AS unknown
      FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
      LEFT JOIN LATERAL(SELECT due_at,warning_at FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1) r ON true
      WHERE a.${column}=ANY($1::uuid[])`,[ids])).rows[0];
    const service = new DigitalProductionTaskService(db);
    const items: CockpitRow[] = [];
    for (const row of visible.slice((input.page-1)*20,input.page*20)) {
      const resourceId = input.stage === "development" ? row.sourceId : row.orderId;
      const taskIds = (await db.query(`SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
        WHERE a.${column}=$1 ORDER BY t.route_version DESC,t.created_at,t.task_id`,[resourceId])).rows;
      const tasks = [];
      for (const task of taskIds) if (await policy.allowed(actor,"task",task.task_id,"technical")) tasks.push(await service.read(actor,task.task_id));
      // P03 owns the declared development-route denominator, including not-yet-created nodes.
      const latest = tasks[0];
      let progress = input.stage === "development" && latest && latest.routeProgress.applicable > 0 ? latest.routeProgress : null;
      if (input.stage === "development") {
        const hasDocuments=(await db.query("SELECT to_regclass('digital_development_documents') AS relation")).rows[0]?.relation;
        if (!hasDocuments || !(await db.query("SELECT 1 FROM digital_development_documents WHERE source_id=$1 AND status='published'",[row.sourceId])).rowCount) progress=null;
      }
      if (input.stage === "bulk") {
        const preparation = (await db.query(`SELECT p.*,v.document,decision.cutting_process,src.document AS source_document FROM digital_bulk_preparations p
          JOIN digital_instruction_versions v ON v.production_order_id=p.production_order_id AND v.version=p.instruction_version
          JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
          JOIN digital_development_current_documents src ON src.source_id=p.source_id
          JOIN sourcing_approval_snapshots a ON a.sourcing_approval_snapshot_id=p.approval_snapshot_id
          JOIN sourcing_decisions decision ON decision.sourcing_decision_id=a.sourcing_decision_id
          WHERE p.production_order_id=$1 AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
          ORDER BY p.created_at DESC LIMIT 1`,[row.orderId])).rows[0];
        if (preparation) {
          const routeIds = new Set((await db.query("SELECT task_id FROM digital_production_tasks WHERE route_instance_id=$1",[preparation.preparation_id])).rows.map(t=>t.task_id));
          const closure = await new OrderClosureService(db).read(actor,row.orderId);
          progress = bulkCockpitProgress({preshrink:preparation.preshrink,secondaryCraft:preparation.document.secondaryCraft==='沿用开发'?preparation.source_document.craft:preparation.document.secondaryCraft,externalCutting:preparation.cutting_process==='outsourced',
            tasks:tasks.filter(t=>routeIds.has(t.taskId)),specialClosed:Boolean(closure.closed),packed:closure.stage==='本期装箱完成',
            received:closure.lines.length>0&&closure.lines.every(l=>l.receiptCount>0&&l.actualQuantity>=l.orderedQuantity&&(l.actualQuantity===l.documentQuantity||Boolean(l.receivingResolution)))});
        }
      }
      const lines = row.orderId && await policy.allowed(actor,"order",row.orderId,"technical") ? (await db.query(`SELECT l.line_id AS id,l.po_number AS po,l.color,coalesce(sum(s.quantity),0)::int AS quantity
        FROM digital_production_po_lines l LEFT JOIN digital_production_po_sizes s USING(line_id) WHERE l.production_order_id=$1 GROUP BY l.line_id ORDER BY l.position`,[row.orderId])).rows : [];
      items.push({...row,deliveryDate:digitalDateText(row.deliveryDate),createdAt:new Date(row.createdAt).toISOString(),tasks,progress,lines});
    }
    const actorName = (await db.query("SELECT display_name FROM app_users WHERE id=$1",[actor.actorId])).rows[0]?.display_name ?? "当前用户";
    return {actorId:actor.actorId,actorName,canViewTodos:Boolean(actor.authorizationCapabilities?.includes("todo:view")),canManagePolicies:isDigitalLeader(actor),page:input.page,total:visible.length,summary,items};
  }
}
