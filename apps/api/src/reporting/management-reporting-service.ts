import { LIST_PAGE_SIZE } from "@dx-rework/contracts/reporting";
import { canAccessFinanceWages, requireFinanceWageAccess } from "../wages/wage-access.js";
import { readFinanceNode } from "./finance-node-reader.js";
import type { FinanceNodeKey } from "@dx-rework/contracts/reporting";
import { canDownloadBasicReworkAttachment, readBasicRework } from "./basic-rework-reader.js";
import type { BasicReworkQuery } from "@dx-rework/contracts/reporting";
import { wageSelection, wageSelectionValues } from "./wage-report-selection.js";
import {readWorkflowAnalysis} from "./workflow-analysis.js";
import type { DashboardQuery, ManagementDashboardResponse, ManagementReworkPage, ManagementReworkQuery, ManagementReworkQueue, ManagementReworkQueueQuery, ReportPreviewResponse, ReportQuery, ReportType, SiteDashboardResponse, WorkflowQueueStatus } from "@dx-rework/contracts/reporting";
import type { Pool,PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { capabilities, fail, nodeMeta, number, reportStatusValues, TIMEZONE, type CountRow, type Queryable, type Range, type ReportData } from "./management-reporting-shared.js";
import { currentExceptionCount, financial as loadFinancial } from "./management-reporting-financial.js";
import { exceptions as loadExceptions } from "./management-reporting-exceptions.js";
import { fetchFacts, fetchQueueCounts, relatedReworkOrderPredicate, type ReworkFactOptions } from "./management-reporting-orders.js";
import type {IeAuthorizedCandidates} from "../production-platform/ie-authorized-directory.js";
import { factDto } from "./management-reporting-dto.js";
import { reportData } from "./management-reporting-report-core.js";
import { recalculateDisplayedTotals } from "./management-reporting-report-exceptions.js";

const workflowCapabilitiesByStatus: Readonly<Record<string, readonly string[]>> = {
  pending_process_configuration: ["process:configure"],
  pending_ie_review: ["process:review"],
  pending_task_assignment: ["work:assign"],
  in_progress: ["work:assign", "work:report", "work:report_for_worker", "tail_inspection:report"],
  pending_order_review: ["submission:audit"],
  pending_final_quantity_ie_review: ["process:review"],
  pending_quantity_adjustment_ie_review: ["quantity:adjust", "quantity:confirm", "process:review"],
  pending_responsibility_determination: ["responsibility:determine", "responsibility:takeover"],
  pending_owner_signature: ["responsibility:owner_sign"],
};

function reworkListAccess(actor: TrustedActorContext) {
  const currentCapabilities = capabilities(actor);
  const broadCapability = ["dashboard:management:read", "dashboard:site:read", "report:view"].find(capability => currentCapabilities.includes(capability));
  const relatedOrderScoped = !broadCapability && currentCapabilities.includes("rework:related_orders:view");
  const capabilityForStatus = (status: string) => workflowCapabilitiesByStatus[status]?.find(capability => currentCapabilities.includes(capability));
  return { currentCapabilities, broadCapability, relatedOrderScoped, capabilityForStatus };
}

async function requireReportingAuthority(source:Queryable,actor:TrustedActorContext,capability:string){
 if(!capabilities(actor).includes(capability))fail(`缺少 ${capability} 能力`);
 await source.query('SELECT access_authorized_actor_roles($1,$2)',[actor.actorId,capability]);
}

export function isReworkWorkflowAuthorityDenial(error:unknown){
 const denied=error as {code?:string;message?:string}|null;
 return denied?.code==='42501'&&(denied.message?.startsWith('actor is not authorized for capability ')||denied.message==='PMC is business read-only');
}

async function authorizedReworkQueues(client:Pick<PoolClient,'query'>,actor:TrustedActorContext,
 access:ReturnType<typeof reworkListAccess>,requested:readonly WorkflowQueueStatus[],
 denied:(error:unknown)=>boolean=error=>(error as {code?:string}|null)?.code==='42501'){
 const shared=access.broadCapability??(access.relatedOrderScoped?'rework:related_orders:view':undefined);
 if(shared){await requireReportingAuthority(client,actor,shared);return [...requested];}
 const available:WorkflowQueueStatus[]=[],checked=new Map<string,boolean>();
 for(const status of requested){
  const needed=access.capabilityForStatus(status);
  if(!needed)continue;
  if(!checked.has(needed)){
   await client.query('SAVEPOINT rework_queue_authority');
   try{await requireReportingAuthority(client,actor,needed);checked.set(needed,true);}
   catch(error){
    if(!denied(error))throw error;
    await client.query('ROLLBACK TO SAVEPOINT rework_queue_authority');checked.set(needed,false);
   }
   await client.query('RELEASE SAVEPOINT rework_queue_authority');
  }
  if(checked.get(needed))available.push(status);
 }
 return available;
}

const ieReworkQueues=['pending_ie_review','pending_final_quantity_ie_review','pending_quantity_adjustment_ie_review'] as const;

/** Only the existing IE workflow queues participate. Read authorization remains that of the original queue. */
export async function reworkIeCandidates(client:Pick<PoolClient,'query'>,actor:TrustedActorContext):Promise<IeAuthorizedCandidates['rework_review']>{
 const access=reworkListAccess(actor);
 const available=await authorizedReworkQueues(client,actor,access,ieReworkQueues,isReworkWorkflowAuthorityDenial);
 if(!available.length)return undefined;
 return ({bind,search})=>{
  const scopes=bind(available);
  const related=access.relatedOrderScoped?`AND ${relatedReworkOrderPredicate(bind(actor.actorId))}`:'';
  return `SELECT order_record.rework_order_id AS object_id,order_record.rework_order_id AS entry_id,order_record.rework_order_id AS resource_id,
    order_record.order_no AS order_id,order_record.style_no,NULL::text AS customer_code,order_record.version,
    NULL::int AS round,order_record.status AS native_status,order_record.updated_at AS sort_at,'awaiting_price'::text AS state
   FROM rework_orders order_record WHERE order_record.status=ANY(${scopes}::text[])
    ${related}
    AND (${search}::text='' OR position(lower(${search}) in lower(order_record.rework_no))>0
     OR position(lower(${search}) in lower(order_record.order_no))>0
     OR position(lower(${search}) in lower(order_record.style_no))>0
     OR position(lower(${search}) in order_record.rework_order_id::text)>0)`;
 };
}

function reworkListFacts(actor: TrustedActorContext, query: ManagementReworkQuery, access: ReturnType<typeof reworkListAccess>, queueStatuses?: readonly string[]): ReworkFactOptions {
  const { broadCapability, currentCapabilities, relatedOrderScoped } = access;
  const scopedWork = !broadCapability && !currentCapabilities.includes("work:assign")
    && (queueStatuses?.includes("in_progress") ?? query.status === "in_progress");
  const ownTask = scopedWork && ((actor.actorRoles.includes("worker") && currentCapabilities.includes("work:report"))
    || (actor.actorRoles.includes("tail_inspector") && currentCapabilities.includes("tail_inspection:report")));
  return {
    ...(query.q ? { q: query.q } : {}),
    ...(queueStatuses ? { queueStatuses } : query.status ? { status: query.status } : {}),
    ...(query.reworkKind ? { reworkKind: query.reworkKind } : {}),
    ...(query.responsibilityType ? { responsibilityType: query.responsibilityType } : {}),
    ...(query.currentHandlerUserId ? { currentHandlerUserId: query.currentHandlerUserId } : {}),
    ...(query.supplierId ? { supplierId: query.supplierId } : {}),
    ...(query.overdue ? { overdue: query.overdue === "true" } : {}),
    ...(query.exception ? { exception: query.exception === "true" } : {}),
    ...(query.from ? { from: query.from } : {}),
    ...(query.to ? { to: query.to } : {}),
    ...(ownTask ? { workTaskActorUserId: actor.actorId } : {}),
    ...(scopedWork && currentCapabilities.includes("work:report_for_worker") ? { includeTemporaryProxyTasks: true } : {}),
    ...(relatedOrderScoped ? { relatedOrderActorUserId: actor.actorId } : {}),
    openFirst: true,
    limit: query.limit,
    offset: (query.page - 1) * query.limit,
  };
}

export class ManagementReportingService {
  constructor(private readonly db: Pool) {}

  private async mayReadWageFields(actor: TrustedActorContext, capability: "wage:view" | "wage:export" = "wage:view"): Promise<boolean> {
    if (!canAccessFinanceWages(actor, capability)) return false;
    try { await requireFinanceWageAccess(this.db, actor, capability); return true; }
    catch (error) {
      if ((error instanceof ApplicationError && error.statusCode === 403) || (error as { code?: string }).code === "42501") return false;
      throw error;
    }
  }

  private withoutWageFields(data: ReportData): ReportData {
    const totals = { ...data.totals };
    delete totals.wageAmount;
    return { ...data, columns: data.columns.filter(column => column.key !== "wageAmount"), totals,
      rows: data.rows.map(row => { const visible = { ...row }; delete visible.wageAmount; return visible; }) };
  }

  async financeNode(actor: TrustedActorContext, orderId: string, node: FinanceNodeKey) {
    return readFinanceNode(this.db,actor,orderId,node);
  }

  async listBasicRework(actor: TrustedActorContext, query: BasicReworkQuery) {
    return readBasicRework(this.db,actor,query);
  }

  async canDownloadBasicReworkAttachment(
    actor: TrustedActorContext,
    binding: Readonly<{ attachmentId?: string; entityType: string; entityId: string; mimeType?: string }>,
  ): Promise<boolean> {
    return canDownloadBasicReworkAttachment(this.db,actor,binding);
  }

  async workflowAnalysis(actor: TrustedActorContext, input: unknown) {
    await this.require(actor, "dashboard:management:read");
    const sourcing = actor.actorRoles.includes("root_superuser") || (actor.authorizationCapabilities ?? []).includes("sourcing:view");
    if (sourcing && !actor.actorRoles.includes("root_superuser")) await this.require(actor,"sourcing:view");
    return readWorkflowAnalysis(this.db,input,sourcing);
  }

  async managementDashboard(actor: TrustedActorContext, query: DashboardQuery): Promise<ManagementDashboardResponse> {
    await this.require(actor, "dashboard:management:read");
    const canReadWages = await this.mayReadWageFields(actor);
    const range = await this.range(query);
    const [counts, financial, exceptions, exceptionCount, recent] = await Promise.all([
      this.db.query<CountRow>(
        `SELECT status,count(*)::text count FROM rework_orders
         WHERE status NOT IN ('cancelled','deleted') GROUP BY status`,
      ),
      loadFinancial(this.db, range),
      loadExceptions(20, this.db),
      currentExceptionCount(this.db),
      fetchFacts(this.db, { limit: 8 }),
    ]);
    const countMap = new Map(counts.rows.map((row) => [row.status, number(row.count)]));
    const nodeCounts = Object.entries(nodeMeta).map(([status, meta]) => ({
      ...meta,
      count: countMap.get(status) ?? 0,
    })).filter((item) => item.count > 0 || item.node !== "N-C");
    const openOrders = [...countMap.entries()].filter(([status]) => !["completed", "cancelled", "deleted"].includes(status)).reduce((sum, [, value]) => sum + value, 0);
    const completedResult = await this.db.query<{ count: string }>(
      `SELECT count(*)::text count FROM rework_orders
       WHERE status='completed' AND (updated_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`,
      [range.from, range.to, TIMEZONE],
    );
    const overdueTodos = await this.db.query<{ count: string }>(
      `WITH todo_order AS (
         SELECT todo.todo_id,
           COALESCE(
             CASE WHEN NULLIF(todo.route_descriptor->>'reworkOrderId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
               THEN NULLIF(todo.route_descriptor->>'reworkOrderId','')::uuid END,
             CASE todo.entity_type
               WHEN 'rework_order' THEN CASE WHEN todo.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN todo.entity_id::uuid END
               WHEN 'own_factory_approval' THEN approval.rework_order_id
               WHEN 'external_responsibility_case' THEN external_case.rework_order_id
               WHEN 'responsibility_determination' THEN determination.rework_order_id
               ELSE NULL
             END
           ) rework_order_id
         FROM rework_todos todo
         LEFT JOIN rework_own_factory_approvals approval
           ON todo.entity_type='own_factory_approval' AND approval.approval_id::text=todo.entity_id
         LEFT JOIN rework_external_responsibility_cases external_case
           ON todo.entity_type='external_responsibility_case' AND external_case.case_id::text=todo.entity_id
         LEFT JOIN rework_responsibility_determinations determination
           ON todo.entity_type='responsibility_determination' AND determination.determination_id::text=todo.entity_id
       )
       SELECT count(*)::text count FROM rework_todos todo
       JOIN todo_order mapped USING(todo_id)
       LEFT JOIN rework_orders order_record ON order_record.rework_order_id=mapped.rework_order_id
       WHERE todo.status='pending' AND todo.due_at IS NOT NULL AND todo.due_at<CURRENT_TIMESTAMP
         AND order_record.status IS DISTINCT FROM 'deleted'`,
    );
    const currentCapabilities = capabilities(actor);
    return {
      mode: "management",
      asOf: range.asOf.toISOString(),
      range: { from: range.from, to: range.to, timezone: TIMEZONE },
      kpis: {
        openOrders,
        completedOrders: number(completedResult.rows[0]?.count ?? "0"),
        overdueTodos: number(overdueTodos.rows[0]?.count ?? "0"),
        exceptionCount,
      },
      nodeCounts,
      financial: canReadWages ? financial : (({ wageTotal: _wageTotal, ...visible }) => { void _wageTotal; return visible; })(financial),
      exceptions,
      recentOrders: recent.rows.map((row) => factDto(row, canReadWages)),
      availableActions: [
        "view_rework" as const,
        ...(currentCapabilities.includes("responsibility:determine") ? ["determine_responsibility" as const] : []),
        ...(currentCapabilities.includes("own_factory:approve") ? ["approve_own_factory" as const] : []),
        ...(currentCapabilities.includes("external_responsibility:view") ? ["manage_external_responsibility" as const] : []),
        ...(canReadWages ? ["review_wages" as const] : []),
        ...(currentCapabilities.includes("report:export") ? ["export_reports" as const] : []),
      ],
    };
  }

  async siteDashboard(actor: TrustedActorContext, query: DashboardQuery): Promise<SiteDashboardResponse> {
    await this.require(actor, "dashboard:site:read");
    const canReadWages = await this.mayReadWageFields(actor);
    const range = await this.range(query);
    const [counts, recent, wageReview, exceptions] = await Promise.all([
      this.db.query<CountRow>(`SELECT status,count(*)::text count FROM rework_orders WHERE status NOT IN ('completed','cancelled','deleted') GROUP BY status`),
      fetchFacts(this.db, { limit: 12, siteOnly: true }),
      canReadWages ? this.db.query<{ count: string }>(`SELECT count(*)::text count FROM rework_wage_periods WHERE status='ready_to_lock'`) : Promise.resolve({ rows: [] }),
      this.db.query<{ count: string }>(
        `SELECT count(DISTINCT order_record.rework_order_id)::text count
         FROM rework_orders order_record
         LEFT JOIN rework_todos todo
           ON todo.entity_type='rework_order' AND todo.entity_id=order_record.rework_order_id::text
         WHERE order_record.status IN (
           'pending_process_configuration','pending_ie_review','pending_task_assignment',
           'in_progress','pending_order_review','pending_final_quantity_ie_review','pending_quantity_adjustment_ie_review'
         ) AND (todo.status='blocked_recipient' OR (todo.status='pending' AND todo.due_at<CURRENT_TIMESTAMP))`,
      ),
    ]);
    const map = new Map(counts.rows.map((row) => [row.status, number(row.count)]));
    const pendingWageMonthClose = number(wageReview.rows[0]?.count ?? "0");
    const nodeCounts = Object.entries(nodeMeta).map(([status, meta]) => ({ ...meta, count: map.get(status) ?? 0 }))
      .filter((item) => ["N02", "N03", "N04", "N05", "N06", "N06-A"].includes(item.node));
    if (canReadWages) nodeCounts.push({ node: "N11", label: "订单完成与后续结算 · 工资可月结", count: pendingWageMonthClose });
    const currentCapabilities = capabilities(actor);
    return {
      mode: "site",
      asOf: range.asOf.toISOString(),
      range: { from: range.from, to: range.to, timezone: TIMEZONE },
      kpis: {
        pendingConfiguration: map.get("pending_process_configuration") ?? 0,
        pendingAssignment: map.get("pending_task_assignment") ?? 0,
        inProgress: map.get("in_progress") ?? 0,
        pendingOrderReview: (map.get("pending_order_review") ?? 0) + (map.get("pending_final_quantity_ie_review") ?? 0) + (map.get("pending_quantity_adjustment_ie_review") ?? 0),
        ...(canReadWages ? { pendingWageReview: pendingWageMonthClose } : {}),
        siteExceptions: number(exceptions.rows[0]?.count ?? "0"),
      },
      nodeCounts,
      recentOrders: recent.rows.map((row) => factDto(row, canReadWages)),
      availableActions: [
        ...(currentCapabilities.includes("process:configure") ? ["configure_process" as const] : []),
        ...(currentCapabilities.includes("work:assign") ? ["assign_work" as const] : []),
        ...(currentCapabilities.includes("submission:audit") ? ["review_order" as const] : []),
        ...(canReadWages ? ["review_wages" as const] : []),
        ...(currentCapabilities.includes("report:export") ? ["export_reports" as const] : []),
      ],
    };
  }

  async listReworkOrders(actor: TrustedActorContext, query: ManagementReworkQuery): Promise<ManagementReworkPage> {
    const access = reworkListAccess(actor);
    const sharedCapability = access.broadCapability ?? (access.relatedOrderScoped ? "rework:related_orders:view" : undefined);
    if (sharedCapability) {
      await this.require(actor, sharedCapability);
    } else {
      if (!query.status) throw new ApplicationError("VALIDATION_ERROR", "节点工作台必须指定当前业务节点", 400);
      const workflowCapability = access.capabilityForStatus(query.status);
      if (!workflowCapability) throw new ApplicationError("FORBIDDEN", "当前岗位无权查看这个业务节点", 403);
      await this.require(actor, workflowCapability);
    }
    const canReadWages = await this.mayReadWageFields(actor);
    return this.reworkPage(this.db, actor, query, access, canReadWages);
  }

  async listReworkQueue(actor: TrustedActorContext, query: ManagementReworkQueueQuery): Promise<ManagementReworkQueue> {
    const access = reworkListAccess(actor);
    const requested = [...new Set(query.statuses)];
    const canReadWages = await this.mayReadWageFields(actor);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const available=await authorizedReworkQueues(client,actor,access,requested);
      const selected = available.includes(query.status) ? query.status : available[0];
      if (!selected) throw new ApplicationError("FORBIDDEN", "当前账号没有可进入的节点队列", 403);
      const pageQuery = {...query, status: selected, page: selected === query.status ? query.page : 1};
      const page = await this.reworkPage(client, actor, pageQuery, access, canReadWages);
      const countByStatus = new Map<string,number>([[selected,page.totalCount]]);
      if(available.length>1||(!page.items.length&&page.page>1)){
        const counts = await fetchQueueCounts(client, reworkListFacts(actor, query, access, available));
        for(const row of counts.rows)countByStatus.set(row.status,number(row.total_count));
      }
      const totalCount=countByStatus.get(selected)??0;
      await client.query("COMMIT");
      return {selected, page:{...page,totalCount,totalPages:Math.max(1,Math.ceil(totalCount/page.pageSize))},
        statuses:available.map(status => ({status,totalCount:countByStatus.get(status) ?? 0}))};
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async reworkPage(
    source: Queryable,
    actor: TrustedActorContext,
    query: ManagementReworkQuery,
    access: ReturnType<typeof reworkListAccess>,
    canReadWages: boolean,
  ): Promise<ManagementReworkPage> {
    const [result, clock] = await Promise.all([
      fetchFacts(source, reworkListFacts(actor, query, access)),
      source.query<{as_of:Date}>("SELECT CURRENT_TIMESTAMP as_of"),
    ]);
    const totalCount = number(result.rows[0]?.total_count ?? "0");
    return {
      asOf: (clock.rows[0]?.as_of ?? new Date(0)).toISOString(),
      items: result.rows.map(row => factDto(row, canReadWages)),
      page: query.page,
      pageSize: query.limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
      canViewReports: access.currentCapabilities.includes("report:view"),
    };
  }

  async report(actor: TrustedActorContext, reportType: ReportType, query: ReportQuery, page?:number): Promise<ReportPreviewResponse> {
    if(page!==undefined && (reportType!=="wages" || !Number.isInteger(page) || page<1 || page>100_000)) fail("工资页码无效",400,"VALIDATION_ERROR");
    this.validateReportStatus(reportType, query.status);
    if (reportType === "wages") await requireFinanceWageAccess(this.db, actor, "wage:view");
    else await this.require(actor, "report:view");
    const canReadWages = reportType === "wages" || (reportType === "rework_overview" && await this.mayReadWageFields(actor));
    const range = await this.range(query);
    const allData = await reportData(this.db, reportType, query, range, page===undefined?query.limit + 1:LIST_PAGE_SIZE, page);
    const data = reportType === "rework_overview" && !canReadWages ? this.withoutWageFields(allData) : allData;
    const truncated = page===undefined && data.rows.length > query.limit;
    const rows = truncated ? data.rows.slice(0, query.limit) : data.rows;
    return {
      reportType,
      ...(data.pagination?{pagination:data.pagination}:{}),
      asOf: range.asOf.toISOString(),
      range: { from: range.from, to: range.to, timezone: TIMEZONE },
      rowCount: rows.length,
      truncated,
      canExport: reportType === "wages"
        ? capabilities(actor).includes("wage:export")
        : capabilities(actor).includes("report:export"),
      totals: reportType === "wages" ? data.totals : recalculateDisplayedTotals(rows, data.totals),
      ...(data.wageSummary ? { wageSummary: data.wageSummary, canSettleWages: this.canSettleWages(actor) } : {}),
      columns: data.columns,
      rows,
    };
  }

  async exportData(actor: TrustedActorContext, reportType: ReportType, query: ReportQuery): Promise<{
    range: Range;
    data: ReportData;
  }> {
    this.validateReportStatus(reportType, query.status);
    if (reportType === "wages") await requireFinanceWageAccess(this.db, actor, "wage:export");
    else await this.require(actor, "report:export");
    const canExportWages = reportType === "wages" || (reportType === "rework_overview" && await this.mayReadWageFields(actor, "wage:export"));
    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const range = await this.range(query, client);
      const allData = await reportData(client, reportType, query, range, 50_001);
      const data = reportType === "rework_overview" && !canExportWages ? this.withoutWageFields(allData) : allData;
      if (data.rows.length > 50_000) fail("导出超过 50000 行，请缩小筛选范围", 413, "EXPORT_TOO_LARGE");
      await client.query("COMMIT");
      return { range, data };
    } catch (error: unknown) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  private canSettleWages(actor: TrustedActorContext): boolean {
    return canAccessFinanceWages(actor, "wage:settlement_mark");
  }

  private async requireSettlement(actor: TrustedActorContext): Promise<void> {
    await requireFinanceWageAccess(this.db, actor, "wage:settlement_mark");
  }

  async previewWageSettlement(actor: TrustedActorContext, query: ReportQuery) {
    await this.requireSettlement(actor);
    this.validateReportStatus("wages",query.status);
    const range = await this.range(query);
    const result = await this.db.query(`${wageSelection}
      SELECT line_id,person_id FROM filtered WHERE marked_at IS NULL ORDER BY line_id`,wageSelectionValues(query,range));
    return { lineIds:result.rows.map(row=>String(row.line_id)),lineCount:result.rows.length,
      personCount:new Set(result.rows.map(row=>String(row.person_id))).size };
  }

  async markWageSettlement(actor: TrustedActorContext, query: ReportQuery, lineIds: readonly string[]) {
    await this.requireSettlement(actor);
    this.validateReportStatus("wages",query.status);
    const range = await this.range(query);
    // One atomic insert: concurrent/retried requests preserve the original marker and timestamp.
    const result = await this.db.query(`${wageSelection}, inserted AS (
      INSERT INTO rework_wage_settlement_marks(line_id,wage_item_id,closure_line_id,pattern_wage_item_id,marked_by)
      SELECT line_id,wage_item_id,closure_line_id,pattern_wage_item_id,$9::uuid FROM filtered
      WHERE marked_at IS NULL AND line_id=ANY($8::uuid[])
      ON CONFLICT(line_id) DO NOTHING RETURNING line_id
    ) SELECT count(*)::int marked_count FROM inserted`,[...wageSelectionValues(query,range),lineIds,actor.actorId]);
    return {markedCount:result.rows[0]!.marked_count as number};
  }

  private validateReportStatus(reportType: ReportType, status: string | undefined): void {
    if (status && !reportStatusValues[reportType].has(status)) {
      fail("报表状态或类型筛选无效", 400, "VALIDATION_ERROR");
    }
  }

  private async require(actor: TrustedActorContext, capability: string, source: Queryable = this.db): Promise<void> {
    return requireReportingAuthority(source,actor,capability);
  }

  private async range(query: DashboardQuery, source: Queryable = this.db): Promise<Range> {
    const result = await source.query<{ as_of: Date; from_date: string; to_date: string }>(
      `SELECT CURRENT_TIMESTAMP as_of,
        COALESCE($1::date,date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE $3)::date)::text from_date,
        COALESCE($2::date,(date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE $3)+interval '1 month - 1 day')::date)::text to_date`,
      [query.from ?? null, query.to ?? null, TIMEZONE],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("INTERNAL_ERROR", "无法取得报表时间范围", 500);
    return { from: row.from_date, to: row.to_date, asOf: row.as_of };
  }

}
