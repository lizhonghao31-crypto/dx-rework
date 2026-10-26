import {developmentReadTables} from "./development-amendment-repository.js";
import {acceptanceClockReaderEnabled} from '../acceptance-clock/business-time.js';
import {savedDevelopmentRoute} from "./development-sla-enrollment.js";
import { DigitalDevelopmentService } from "./development-service.js";
import { OrderClosureService } from "./order-closure-service.js";
import { bulkCockpitProgress } from "./cockpit-progress.js";
import { BulkPreparationService } from "./bulk-preparation-service.js";
import type { Pool } from "pg";
import type { CockpitResult, CockpitRow, CockpitStage } from "@dx-rework/contracts/digital-production-cockpit";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy, isDigitalLeader, isDigitalTechnicalManager } from "./access-policy.js";
import { assertIdentityActor, digitalDateText } from "./identity-service.js";
import { DigitalProductionTaskService } from "./task-service.js";
import { readOrderPoDeliveryDates } from "./po-delivery-query.js";

/** Read-only projection. Resource authorization is identical to original-page access. */
export class DigitalCockpitQuery {
  constructor(private readonly database: Pool) {}
  async list(actor: TrustedActorContext, input: { page: number; search: string; stage: CockpitStage; workload?: "all"|"unassigned"|"blocked"|"urgent" }): Promise<CockpitResult> {
    assertIdentityActor(actor);
    const db = this.database;
    const policy = new DigitalProductionAccessPolicy(db);
    // Match resource policy in one SQL scope; never authorize the full history row by row.
    const activeRole = (role: string) => `EXISTS(SELECT 1 FROM app_users au JOIN user_role_assignments ar ON ar.user_id=au.id JOIN business_roles br ON br.role_code=ar.role_code AND br.enabled WHERE au.id=$4 AND au.enabled AND coalesce((to_jsonb(au)->>'manual_access_disabled')::boolean,false)=false AND (ar.role_code=${role} OR (${role}='warehouse_receiver' AND ar.role_code='warehouse_supervisor')) AND ar.revoked_at IS NULL AND EXISTS(SELECT 1 FROM identity_mappings ai WHERE ai.user_id=au.id AND ai.active AND ai.employed))`;
    const clerk = `('development_clerk'=ANY($5::text[]) AND ${activeRole("'development_clerk'")})`;
    let bulkTasks='false';
    if(input.stage==='bulk'&&(await db.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation) bulkTasks=`EXISTS(SELECT 1 FROM digital_production_task_access ba JOIN digital_production_tasks bt USING(task_id) JOIN digital_bulk_preparations bp ON bp.preparation_id=bt.route_instance_id AND bp.production_order_id=ba.production_order_id JOIN digital_instruction_documents bi ON bi.production_order_id=bp.production_order_id AND bi.published_version=bp.instruction_version WHERE ba.production_order_id=o.production_order_id AND bt.state<>'cancelled' AND bp.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=bp.source_id),1) AND ba.task_kind IN ('bulk_pattern','warehouse_preshrink','bulk_cutting','bulk_cutting_external','process_logistics','bulk_qc','warehouse_dispatch','factory_material_count','bulk_ship_sample') AND ((ba.assignee_id=$4 AND ${activeRole('ba.required_role')})))`;
    // Task assignment gives resource visibility, not blanket access to its other tasks.
    const developmentTasks=`EXISTS(SELECT 1 FROM digital_production_task_access da JOIN digital_production_tasks dt USING(task_id) WHERE da.source_id=s.source_id AND da.task_kind LIKE 'development_%' AND ((da.assignee_id=$4 AND ${activeRole('da.required_role')})))`;
    const scope=input.stage==='development'
      ? `($6 OR $7 OR ('sample_designer'=ANY($5::text[]) AND s.created_by=$4) OR ('order_merchandiser'=ANY($5::text[]) AND ${activeRole("'order_merchandiser'")} AND EXISTS(SELECT 1 FROM digital_production_orders mo WHERE mo.source_id=s.source_id AND mo.primary_merchandiser_id=$4)) OR ${developmentTasks} OR (${clerk} AND EXISTS(SELECT 1 FROM digital_production_task_access ca WHERE ca.source_id=s.source_id AND ca.task_kind LIKE 'development_%')))`
      : `($6 OR $7 OR ('sample_designer'=ANY($5::text[]) AND o.created_by=$4) OR ('order_merchandiser'=ANY($5::text[]) AND o.primary_merchandiser_id=$4) OR (${clerk} AND o.source_id IS NOT NULL) OR ${bulkTasks})`;
    const column = input.stage === "development" ? "source_id" : "production_order_id";
    const visibleColumn=input.stage==='development'?'sourceId':'orderId';
    const comparisonTime=acceptanceClockReaderEnabled(this.database)?`coalesce((SELECT c.business_now FROM acceptance_sla_clock_resources m JOIN acceptance_sla_clock_scenarios c USING(scenario_id) WHERE m.resource_kind='${input.stage==='development'?'source':'order'}' AND m.resource_id=a.${column}),CURRENT_TIMESTAMP)`:'CURRENT_TIMESTAMP';
    const deadlineFields=acceptanceClockReaderEnabled(this.database)?'due_at,warning_at,sla_basis':'due_at,warning_at';
    const overdueCondition=acceptanceClockReaderEnabled(this.database)?`CASE WHEN r.sla_basis IS NOT NULL AND coalesce((r.sla_basis->>'exclusive')::boolean,false)=false THEN r.due_at<${comparisonTime} ELSE r.due_at<=${comparisonTime} END`:`r.due_at<=${comparisonTime}`;
    const dueSoonCondition=acceptanceClockReaderEnabled(this.database)?`r.warning_at<=${comparisonTime} AND NOT (${overdueCondition})`:`r.warning_at<=${comparisonTime} AND r.due_at>${comparisonTime}`;
    const result=(await db.query(`WITH visible AS (
SELECT o.production_order_id AS "orderId",s.source_id AS "sourceId",
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
      AND ${scope}
    ), totals AS (SELECT count(*)::int AS total FROM visible), page AS (
      SELECT * FROM visible ORDER BY "createdAt" DESC,id DESC LIMIT 15 OFFSET $8
    ), summary AS (
      SELECT count(DISTINCT a.${column}) FILTER(WHERE t.state NOT IN ('completed','cancelled'))::int AS active,
      count(DISTINCT a.${column}) FILTER(WHERE t.state='blocked')::int AS blocked,
      count(DISTINCT a.${column}) FILTER(WHERE t.state IN ('ready','blocked') AND (${overdueCondition}))::int AS overdue,
      count(DISTINCT a.${column}) FILTER(WHERE t.state IN ('ready','blocked') AND (${dueSoonCondition}))::int AS "dueSoon",
      count(DISTINCT a.${column}) FILTER(WHERE t.state IN ('ready','blocked') AND t.entered_at IS NULL)::int AS unknown
      FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
      LEFT JOIN LATERAL(SELECT ${deadlineFields} FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1) r ON true
      WHERE EXISTS(SELECT 1 FROM visible v WHERE v."${visibleColumn}"=a.${column})
    ) SELECT totals.total,row_to_json(summary) AS summary,coalesce((SELECT json_agg(page) FROM page),'[]'::json) AS items FROM totals CROSS JOIN summary`,[input.stage,input.search,input.workload??"all",actor.actorId,actor.actorRoles,isDigitalLeader(actor),isDigitalTechnicalManager(actor),(input.page-1)*15])).rows[0];
    const summary=result.summary;
    const service = new DigitalProductionTaskService(db);
    const items: CockpitRow[] = [];
    const hasDocuments=Boolean((await db.query("SELECT to_regclass('digital_development_documents') AS relation")).rows[0]?.relation);
    // Fetch display metadata once for this authorized, bounded page.
    const sourceIds: string[] = result.items.map((row: {sourceId: string|null})=>row.sourceId).filter(Boolean);
    const hasRounds = hasDocuments && Boolean((await db.query("SELECT to_regclass('digital_development_rounds') AS relation")).rows[0]?.relation);
    const sheets = hasDocuments ? (await db.query(`SELECT source_id,document,status FROM ${hasRounds?(await developmentReadTables(db)).current:'digital_development_documents'} WHERE source_id=ANY($1::uuid[])`,[sourceIds])).rows : [];
    const rounds = hasRounds
      ? (await db.query("SELECT source_id,round_number,route_nodes FROM digital_development_rounds WHERE source_id=ANY($1::uuid[])",[sourceIds])).rows : [];
    const labels = hasDocuments ? (await db.query("SELECT DISTINCT ON(node_key) node_key,label FROM digital_production_deadline_policies ORDER BY node_key,version DESC")).rows : [];
    for (const row of result.items) {
      const resourceId = input.stage === "development" ? row.sourceId : row.orderId;
      const taskIds = (await db.query(`SELECT t.task_id,EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
        WHERE a.${column}=$1 ORDER BY t.route_version DESC,t.created_at,t.task_id`,[resourceId])).rows;
      const tasks: Awaited<ReturnType<DigitalProductionTaskService["read"]>>[] = [];
      for (const task of taskIds) if (await policy.allowed(actor,"task",task.task_id,"technical")) tasks.push(await service.read(actor,task.task_id));
      // P03 owns the declared development-route denominator, including not-yet-created nodes.
      const latest = tasks[0];
      let progress = input.stage === "development" && latest && latest.routeProgress.applicable > 0 ? latest.routeProgress : null;
      if (input.stage === "development") {
        if (!hasDocuments || !sheets.some(sheet=>sheet.source_id===row.sourceId&&sheet.status==='published')) progress=null;
      }
      if (input.stage === "bulk") {
        const preparation = (await db.query(`SELECT p.*,v.document,decision.cutting_process,src.document AS source_document FROM digital_bulk_preparations p
          JOIN digital_instruction_versions v ON v.production_order_id=p.production_order_id AND v.version=p.instruction_version
          JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
          JOIN digital_development_current_documents src ON src.source_id=p.source_id
          LEFT JOIN sourcing_approval_snapshots a ON a.sourcing_approval_snapshot_id=p.approval_snapshot_id
          LEFT JOIN sourcing_decisions decision ON decision.sourcing_decision_id=a.sourcing_decision_id
          WHERE p.production_order_id=$1 AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
          ORDER BY p.created_at DESC LIMIT 1`,[row.orderId])).rows[0];
        if (preparation) {
          // Parallel technical preparation may predate its commercial approval.
          // Read the real current approval without inventing or backfilling its FK.
          const cuttingProcess=preparation.cutting_process??(await new BulkPreparationService(db).gates(db,row.orderId)).approval?.cutting_process;
          const routeIds = new Set((await db.query("SELECT task_id FROM digital_production_tasks WHERE route_instance_id=$1 OR (route_instance_id=$2 AND node_key='bulk_ship_sample')",[preparation.preparation_id,row.orderId])).rows.map(t=>t.task_id));
          const closure = await new OrderClosureService(db).read(actor,row.orderId);
          if(cuttingProcess)progress = bulkCockpitProgress({preshrink:preparation.preshrink,secondaryCraft:preparation.document.secondaryCraft==='沿用开发'?preparation.source_document.craft:preparation.document.secondaryCraft,externalCutting:cuttingProcess==='outsourced',
            tasks:tasks.filter(t=>routeIds.has(t.taskId)),specialClosed:Boolean(closure.closed),packed:closure.stage==='本期装箱完成',
            received:closure.lines.length>0&&closure.lines.every(l=>l.receiptCount>0&&l.actualQuantity>=l.orderedQuantity&&(l.actualQuantity===l.documentQuantity||Boolean(l.receivingResolution)))});
        }
      }
      const lines = row.orderId && await policy.allowed(actor,"order",row.orderId,"technical") ? (await db.query(`SELECT l.line_id AS id,l.po_number AS po,l.color,coalesce(sum(s.quantity),0)::int AS quantity
        FROM digital_production_po_lines l LEFT JOIN digital_production_po_sizes s USING(line_id) WHERE l.production_order_id=$1 GROUP BY l.line_id ORDER BY l.position`,[row.orderId])).rows : [];
      const effectiveTasks=tasks.filter(task=>!taskIds.find(item=>item.task_id===task.taskId)?.returned);
      let flow:CockpitRow["flow"]=effectiveTasks.filter(task=>task.routeVersion===(latest?.routeVersion??1)).map(task=>({key:task.taskKind,label:task.label,state:task.state,taskId:task.taskId}));
      let styleImageId:string|null=null;
      const fullSourceAccess=Boolean(row.sourceId&&await policy.allowed(actor,"source",row.sourceId,"technical"));
      if(hasDocuments&&row.sourceId&&(fullSourceAccess||tasks.some(task=>task.sourceId===row.sourceId))) {
        const sheet=sheets.find(item=>item.source_id===row.sourceId);
        const document=sheet?.document;
        if(input.stage==='development'&&sheet?.status==='published') {
          const declared:string[]=(latest?.routeVersion??1)===1?['development_materials',...await savedDevelopmentRoute(db,row.sourceId,document)]:rounds.find(round=>round.source_id===row.sourceId&&round.round_number===latest!.routeVersion)?.route_nodes??[];
          const nodes=declared.filter(node=>!['development_material_supply','development_craft_dispatch','development_sewing_transfer','development_washing_dispatch'].includes(node));
          flow=nodes.map(key=>{const match=effectiveTasks.filter(task=>task.routeVersion===(latest?.routeVersion??1)&&(task.taskKind===key||(key==='development_materials'&&task.taskKind==='development_material_recheck'))).sort((a,b)=>b.occurrence-a.occurrence)[0];return {key,label:labels.find(item=>item.node_key===key)?.label??key,state:match?.state??(fullSourceAccess?'uncreated':'unavailable'),taskId:match?.taskId??null};});
        }
        if(document?.template)row.category=document.template;
        const image=document?.files?.find((file:{kind:string})=>file.kind==='款图');
        if(image&&await new DigitalDevelopmentService(db,false).canDownload(actor,row.sourceId,image.attachmentId))styleImageId=image.attachmentId;
      }
      const poDeliveryDates=row.orderId?await readOrderPoDeliveryDates(db,row.orderId,lines.map(line=>line.id)):[];
      items.push({...row,styleImageId,flow,deliveryDate:digitalDateText(row.deliveryDate),poDeliveryDates,createdAt:new Date(row.createdAt).toISOString(),tasks,progress,lines});
    }
    const actorName = (await db.query("SELECT display_name FROM app_users WHERE id=$1",[actor.actorId])).rows[0]?.display_name ?? "当前用户";
    return {actorId:actor.actorId,actorName,canViewTodos:Boolean(actor.authorizationCapabilities?.includes("todo:view")),canManagePolicies:isDigitalLeader(actor),page:input.page,total:result.total,summary,items};
  }
}
