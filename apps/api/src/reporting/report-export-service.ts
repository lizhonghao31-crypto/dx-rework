import { randomUUID } from "node:crypto";

import { BUSINESS_TIME_ZONE, businessCellValue, businessFieldLabel, isBusinessMoneyField, isBusinessNumberField } from "@dx-rework/contracts/business-display";
import type { ReportQuery, ReportType } from "@dx-rework/contracts/reporting";

import { assertBusinessExportAllowed, assertWageDataExportAllowed } from "../access/export-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type SqlClient, type TrustedActorContext } from "../tools/repositories.js";
import type { ManagementReportingService } from "./management-reporting-service.js";
import { buildWorkbook, workbookNumberCell, type WorkbookCell } from "./xlsx-workbook.js";

const reportNames: Record<ReportType, string> = {
  rework_overview: "返工总览",
  wages: "工资明细",
  responsibilities: "责任明细",
  own_factory: "本厂承担",
  external_deductions: "外部扣款",
  exceptions: "异常明细",
};

const exportCell = (
  key: string,
  value: string | number | boolean | null,
): WorkbookCell => {
  if (
    (typeof value === "string" || typeof value === "number")
    && (isBusinessMoneyField(key) || isBusinessNumberField(key))
  ) {
    return workbookNumberCell(value);
  }
  if (key === "settlementStatus") return value === "settled" ? "已结算" : "未结算";
  return businessCellValue(key, value);
};

const sheetRows = (
  columns: readonly { key: string; label: string }[],
  rows: readonly Record<string, string | number | boolean | null>[],
): WorkbookCell[][] => [
  columns.map((column) => column.label),
  ...rows.map((row) => columns.map((column) =>
    exportCell(column.key, row[column.key] ?? null))),
];

export class ReportExportService {
  constructor(
    private readonly reporting: ManagementReportingService,
    private readonly auditClient: SqlClient,
    private readonly gitSha: string,
    private readonly events = new OperationEventRepository(),
  ) {}

  async export(actor: TrustedActorContext, reportType: ReportType, query: ReportQuery): Promise<{
    filename: string;
    content: Buffer;
  }> {
    const root = actor.actorRoles.includes("root_superuser");
    const currentCapabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (reportType === "wages") {
      assertWageDataExportAllowed(actor.actorRoles);
      if (!root && !currentCapabilities.includes("wage:view")) {
        throw new ApplicationError("FORBIDDEN", "当前身份无权查看工资明细", 403);
      }
    } else {
      assertBusinessExportAllowed(actor.actorRoles, "report:export");
      if (!root && !currentCapabilities.includes("report:view")) {
        throw new ApplicationError("FORBIDDEN", "当前身份无权查看该报表", 403);
      }
    }

    const { range, data } = await this.reporting.exportData(actor, reportType, query);
    const filename = `${reportNames[reportType]}-${range.from}-${range.to}.xlsx`;
    const filterRows: WorkbookCell[][] = [
      ["报表类型", reportNames[reportType]],
      ["数据快照时间", businessCellValue("createdAt", range.asOf.toISOString())],
      ["业务时区", BUSINESS_TIME_ZONE],
      ["开始日期", range.from],
      ["结束日期", range.to],
      ["关键词", query.q ?? ""],
      ...(reportType === "wages" ? [["工人类型",query.personType === "internal" ? "正式工" : query.personType === "temporary" ? "临时工" : "全部"]] : []),
      ["状态", businessCellValue("status", query.status ?? "")],
      ["明细行数", data.rows.length],
      ["Git SHA", this.gitSha],
      ...Object.entries(data.totals).map(([key, value]) => [`合计 ${businessFieldLabel(key)}`, exportCell(key, value)]),
    ];
    const summaryRows: WorkbookCell[][] = [
      ["指标", "值"],
      ["明细行数", data.rows.length],
      ...Object.entries(data.totals).map(([key, value]) => [businessFieldLabel(key), exportCell(key, value)]),
    ];
    const content = buildWorkbook([
      { name: "导出说明", rows: filterRows },
      { name: "明细", rows: sheetRows(data.columns, data.rows) },
      { name: "汇总", rows: summaryRows },
    ]);

    await this.events.append(this.auditClient, actor, {
      action: "report.exported",
      entityType: "report_export",
      entityId: randomUUID(),
      after: {
        reportType,
        filters: query,
        range: { from: range.from, to: range.to },
        snapshotAt: range.asOf.toISOString(),
        rowCount: data.rows.length,
        filename,
      },
    });

    return { filename, content };
  }
}
