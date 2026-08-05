import type { ReportQuery, ReportType } from "@dx-rework/contracts/reporting";

import type { TrustedActorContext } from "../tools/repositories.js";
import type { ManagementReportingService } from "./management-reporting-service.js";
import { buildWorkbook, type WorkbookCell } from "./xlsx-workbook.js";

const reportNames: Record<ReportType, string> = {
  rework_overview: "返工总览",
  wages: "工资明细",
  responsibilities: "责任明细",
  own_factory: "本厂承担",
  external_deductions: "外部扣款",
  exceptions: "异常明细",
};

const sheetRows = (
  columns: readonly { key: string; label: string }[],
  rows: readonly Record<string, string | number | boolean | null>[],
): WorkbookCell[][] => [
  columns.map((column) => column.label),
  ...rows.map((row) => columns.map((column) => row[column.key] ?? null)),
];

export class ReportExportService {
  constructor(
    private readonly reporting: ManagementReportingService,
    private readonly gitSha: string,
  ) {}

  async export(actor: TrustedActorContext, reportType: ReportType, query: ReportQuery): Promise<{
    filename: string;
    content: Buffer;
  }> {
    const { range, data } = await this.reporting.exportData(actor, reportType, query);
    const filterRows: WorkbookCell[][] = [
      ["报表类型", reportNames[reportType]],
      ["数据快照时间", range.asOf.toISOString()],
      ["业务时区", "Asia/Singapore"],
      ["开始日期", range.from],
      ["结束日期", range.to],
      ["关键词", query.q ?? ""],
      ["状态", query.status ?? ""],
      ["明细行数", data.rows.length],
      ["Git SHA", this.gitSha],
      ...Object.entries(data.totals).map(([key, value]) => [`合计 ${key}`, value]),
    ];
    const summaryRows: WorkbookCell[][] = [
      ["指标", "值"],
      ["明细行数", data.rows.length],
      ...Object.entries(data.totals).map(([key, value]) => [key, value]),
    ];
    const content = buildWorkbook([
      { name: "导出说明", rows: filterRows },
      { name: "明细", rows: sheetRows(data.columns, data.rows) },
      { name: "汇总", rows: summaryRows },
    ]);
    return {
      filename: `${reportNames[reportType]}-${range.from}-${range.to}.xlsx`,
      content,
    };
  }
}
