import type { DashboardQuery, ManagementDashboardResponse, ManagementReworkPage, ManagementReworkQuery, ReportPreviewResponse, ReportQuery, ReportType, SiteDashboardResponse } from "@dx-rework/contracts/reporting";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { capabilities, decodeCursor, encodeCursor, fail, nodeMeta, number, reportStatusValues, TIMEZONE, type CountRow, type Queryable, type Range, type ReportData } from "./management-reporting-shared.js";
import { currentExceptionCount, financial as loadFinancial } from "./management-reporting-financial.js";
import { exceptions as loadExceptions } from "./management-reporting-exceptions.js";
import { fetchFacts } from "./management-reporting-orders.js";
import { factDto } from "./management-reporting-dto.js";
import { reportData } from "./management-reporting-report-core.js";
import { recalculateDisplayedTotals } from "./management-reporting-report-exceptions.js";

const workflowCapabilitiesByStatus: Readonly<Record<string, readonly string[]>> = {
  pending_process_configuration: ["process:configure"],
  pending_ie_review: ["process:review"],
  pending_task_assignment: ["work:assign"],
  in_progress: ["work:assign", "work:report", "work:report_for_worker"],
  pending_order_review: ["submission:audit"],
  pending_quantity_adjustment_ie_review: ["quantity:adjust", "quantity:confirm", "process:review"],
  pending_responsibility_determination: ["responsibility:determine", "responsibility:takeover"],
  pending_owner_signature: ["responsibility:owner_sign"],
};

export class ManagementReportingService {
  constructor(private readonly db: Pool) {}

  async managementDashboard(actor: TrustedActorContext, query: DashboardQuery): Promise<ManagementDashboardResponse> {
    await this.require(actor, "dashboard:management:read");
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
      financial,
      exceptions,
      recentOrders: recent.rows.map((row) => factDto(row)),
      availableActions: [
        "view_rework" as const,
        ...(currentCapabilities.includes("responsibility:determine") ? ["determine_responsibility" as const] : []),
        ...(currentCapabilities.includes("own_factory:approve") ? ["approve_own_factory" as const] : []),
        ...(currentCapabilities.includes("external_responsibility:view") ? ["manage_external_responsibility" as const] : []),
        ...(currentCapabilities.includes("wage:view") ? ["review_wages" as const] : []),
        ...(currentCapabilities.includes("report:export") ? ["export_reports" as const] : []),
      ],
    };
  }

  async siteDashboard(actor: TrustedActorContext, query: DashboardQuery): Promise<SiteDashboardResponse> {
    await this.require(actor, "dashboard:site:read");
    const range = await this.range(query);
    const [counts, recent, wageReview, exceptions] = await Promise.all([
      this.db.query<CountRow>(`SELECT status,count(*)::text count FROM rework_orders WHERE status NOT IN ('completed','cancelled','deleted') GROUP BY status`),
      fetchFacts(this.db, { limit: 12, siteOnly: true }),
      this.db.query<{ count: string }>(`SELECT count(*)::text count FROM rework_wage_periods WHERE status='ready_to_lock'`),
      this.db.query<{ count: string }>(
        `SELECT count(DISTINCT order_record.rework_order_id)::text count
         FROM rework_orders order_record
         LEFT JOIN rework_todos todo
           ON todo.entity_type='rework_order' AND todo.entity_id=order_record.rework_order_id::text
         WHERE order_record.status IN (
           'pending_process_configuration','pending_ie_review','pending_task_assignment',
           'in_progress','pending_order_review','pending_quantity_adjustment_ie_review'
         ) AND (todo.status='blocked_recipient' OR (todo.status='pending' AND todo.due_at<CURRENT_TIMESTAMP))`,
      ),
    ]);
    const map = new Map(counts.rows.map((row) => [row.status, number(row.count)]));
    const pendingWageMonthClose = number(wageReview.rows[0]?.count ?? "0");
    const nodeCounts = Object.entries(nodeMeta).map(([status, meta]) => ({ ...meta, count: map.get(status) ?? 0 }))
      .filter((item) => ["N02", "N03", "N04", "N05", "N06", "N06-A"].includes(item.node));
    nodeCounts.push({ node: "N11", label: "订单完成与后续结算 · 工资可月结", count: pendingWageMonthClose });
    const currentCapabilities = capabilities(actor);
    return {
      mode: "site",
      asOf: range.asOf.toISOString(),
      range: { from: range.from, to: range.to, timezone: TIMEZONE },
      kpis: {
        pendingConfiguration: map.get("pending_process_configuration") ?? 0,
        pendingAssignment: map.get("pending_task_assignment") ?? 0,
        inProgress: map.get("in_progress") ?? 0,
        pendingOrderReview: (map.get("pending_order_review") ?? 0) + (map.get("pending_quantity_adjustment_ie_review") ?? 0),
        pendingWageReview: pendingWageMonthClose,
        siteExceptions: number(exceptions.rows[0]?.count ?? "0"),
      },
      nodeCounts,
      recentOrders: recent.rows.map((row) => factDto(row)),
      availableActions: [
        ...(currentCapabilities.includes("process:configure") ? ["configure_process" as const] : []),
        ...(currentCapabilities.includes("work:assign") ? ["assign_work" as const] : []),
        ...(currentCapabilities.includes("submission:audit") ? ["review_order" as const] : []),
        ...(currentCapabilities.includes("wage:tail_review") ? ["review_wages" as const] : []),
        ...(currentCapabilities.includes("report:export") ? ["export_reports" as const] : []),
      ],
    };
  }

  async listReworkOrders(actor: TrustedActorContext, query: ManagementReworkQuery): Promise<ManagementReworkPage> {
    const currentCapabilities = capabilities(actor);
    const broadCapability = currentCapabilities.includes("dashboard:management:read")
      ? "dashboard:management:read"
      : currentCapabilities.includes("dashboard:site:read")
        ? "dashboard:site:read"
        : currentCapabilities.includes("report:view")
          ? "report:view"
          : undefined;
    if (broadCapability) {
      await this.require(actor, broadCapability);
    } else {
      const workflowStatus = query.status;
      if (!workflowStatus) {
        throw new ApplicationError("VALIDATION_ERROR", "节点工作台必须指定当前业务节点", 400);
      }
      const workflowCapability = workflowCapabilitiesByStatus[workflowStatus]
        ?.find((capability: string) => currentCapabilities.includes(capability));
      if (!workflowCapability) {
        throw new ApplicationError("FORBIDDEN", "当前岗位无权查看这个业务节点", 403);
      }
      await this.require(actor, workflowCapability);
    }

    const cursor = decodeCursor(query.cursor);
    const overdue = query.overdue === "true" ? true : query.overdue === "false" ? false : undefined;
    const exception = query.exception === "true" ? true : query.exception === "false" ? false : undefined;
    const workerScoped = !broadCapability
      && query.status === "in_progress"
      && actor.actorRoles.includes("worker")
      && currentCapabilities.includes("work:report")
      && !currentCapabilities.includes("work:assign");
    const proxyScoped = !broadCapability
      && query.status === "in_progress"
      && currentCapabilities.includes("work:report_for_worker")
      && !currentCapabilities.includes("work:assign");
    const [result, clock] = await Promise.all([fetchFacts(this.db, {
      ...(query.q ? { q: query.q } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.responsibilityType ? { responsibilityType: query.responsibilityType } : {}),
      ...(query.currentHandlerUserId ? { currentHandlerUserId: query.currentHandlerUserId } : {}),
      ...(query.supplierId ? { supplierId: query.supplierId } : {}),
      ...(overdue === undefined ? {} : { overdue }),
      ...(exception === undefined ? {} : { exception }),
      ...(query.from ? { from: query.from } : {}),
      ...(query.to ? { to: query.to } : {}),
      ...(workerScoped ? { workTaskActorUserId: actor.actorId } : {}),
      ...(proxyScoped ? { includeTemporaryProxyTasks: true } : {}),
      limit: query.limit + 1,
      ...(cursor ? { cursor } : {}),
    }), this.db.query<{ as_of: Date }>("SELECT CURRENT_TIMESTAMP as_of")]);
    const hasMore = result.rows.length > query.limit;
    const rows = hasMore ? result.rows.slice(0, query.limit) : result.rows;
    return {
      asOf: (clock.rows[0]?.as_of ?? new Date(0)).toISOString(),
      items: rows.map((row) => factDto(row)),
      nextCursor: hasMore && rows.at(-1) ? encodeCursor(rows.at(-1)!) : null,
      canViewReports: currentCapabilities.includes("report:view"),
    };
  }

  async report(actor: TrustedActorContext, reportType: ReportType, query: ReportQuery): Promise<ReportPreviewResponse> {
    this.validateReportStatus(reportType, query.status);
    const currentCapabilities = capabilities(actor);
    const requiredCapability = reportType === "wages" && currentCapabilities.includes("wage:view")
      ? "wage:view"
      : "report:view";
    await this.require(actor, requiredCapability);
    const range = await this.range(query);
    const data = await reportData(this.db, reportType, query, range, query.limit + 1);
    const truncated = data.rows.length > query.limit;
    const rows = truncated ? data.rows.slice(0, query.limit) : data.rows;
    return {
      reportType,
      asOf: range.asOf.toISOString(),
      range: { from: range.from, to: range.to, timezone: TIMEZONE },
      rowCount: rows.length,
      truncated,
      canExport: capabilities(actor).includes("report:export"),
      totals: recalculateDisplayedTotals(rows, data.totals),
      columns: data.columns,
      rows,
    };
  }

  async exportData(actor: TrustedActorContext, reportType: ReportType, query: ReportQuery): Promise<{
    range: Range;
    data: ReportData;
  }> {
    this.validateReportStatus(reportType, query.status);
    await this.require(actor, "report:export");
    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const range = await this.range(query, client);
      const data = await reportData(client, reportType, query, range, 50_001);
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

  private validateReportStatus(reportType: ReportType, status: string | undefined): void {
    if (status && !reportStatusValues[reportType].has(status)) {
      fail("报表状态或类型筛选无效", 400, "VALIDATION_ERROR");
    }
  }

  private async require(actor: TrustedActorContext, capability: string): Promise<void> {
    if (!capabilities(actor).includes(capability)) fail(`缺少 ${capability} 能力`);
    await this.db.query("SELECT access_authorized_actor_roles($1,$2)", [actor.actorId, capability]);
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
