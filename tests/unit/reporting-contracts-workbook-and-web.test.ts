import { readFile } from "node:fs/promises";

import {
  DashboardQuerySchema,
  ManagementReworkQuerySchema,
  ReportQuerySchema,
  ReportTypeSchema,
} from "@dx-rework/contracts/reporting";
import { describe, expect, it } from "vitest";

import { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import { buildWorkbook } from "../../apps/api/src/reporting/xlsx-workbook.js";


describe("PR-14 reporting contracts, workbook and web wiring", () => {
  it("keeps report filters strict and bounded", () => {
    expect(DashboardQuerySchema.safeParse({ from: "2026-08-02", to: "2026-08-01" }).success).toBe(false);
    expect(DashboardQuerySchema.safeParse({ extra: true }).success).toBe(false);
    expect(ManagementReworkQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(ManagementReworkQuerySchema.safeParse({ cursor: "not+base64" }).success).toBe(false);
    expect(ReportQuerySchema.parse({ limit: "500" }).limit).toBe(500);
    expect(ReportQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
    expect(ReportTypeSchema.options).toEqual([
      "rework_overview",
      "wages",
      "responsibilities",
      "own_factory",
      "external_deductions",
      "exceptions",
    ]);
  });


  it("rejects a status filter that does not belong to the selected report", async () => {
    const service = new ManagementReportingService({} as never);
    await expect(service.report({
      actorId: "00000000-0000-4000-8000-000000000001",
      actorRoles: ["owner_group"],
      authorizationCapability: "report:view",
      authorizationCapabilities: ["report:view"],
      requestId: "report-filter-test",
    }, "wages", { status: "approved", limit: 100 })).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      statusCode: 400,
    });
  });

  it("builds deterministic multi-sheet XLSX and keeps formula-looking input as inline text", () => {
    const sheets = [
      { name: "导出说明", rows: [["字段", "值"], ["公式样文本", "=SUM(A1:A2)"]] },
      { name: "明细", rows: [["金额"], ["1.00"]] },
      { name: "汇总", rows: [["合计", "1.00"]] },
    ] as const;
    const first = buildWorkbook(sheets);
    const second = buildWorkbook(sheets);
    expect(first.subarray(0, 2).toString()).toBe("PK");
    expect(first.equals(second)).toBe(true);
    expect(first.includes(Buffer.from('t="inlineStr"'))).toBe(true);
    expect(first.includes(Buffer.from("=SUM(A1:A2)"))).toBe(true);
    expect(first.includes(Buffer.from("xl/worksheets/sheet3.xml"))).toBe(true);
  });

  it("replaces fixture dashboards and task lists with real reporting clients", async () => {
    const [app, dashboard, query, report, client, migration] = await Promise.all([
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/reporting/management-dashboard-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/reporting/rework-query-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/reporting/report-center-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/reporting/reporting-client.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0029_management_dashboard_reporting.sql", import.meta.url), "utf8"),
    ]);
    expect(app).toContain('<ManagementDashboardPage mode="management"');
    expect(app).toContain('<ManagementDashboardPage mode="site"');
    expect(app).toContain("<ReworkQueryPage");
    expect(app).toContain("<ReportCenterPage");
    expect(app).not.toContain("<Dashboard");
    expect(app).not.toContain("<Tasks");
    expect(dashboard).not.toContain("window.setInterval");
    expect(dashboard).not.toContain('window.addEventListener("focus"');
    expect(query).toContain("AbortController");
    expect(query).toContain('["draft","草稿"]');
    expect(report).toContain("reportExportUrl");
    expect(client).toContain("ManagementDashboardResponseSchema");
    expect(client).toContain("createWebUrls");
    expect(client).toContain('import { shanghaiBusinessDate } from "../business-date.js";');
    expect(client).toContain("export const reportingBusinessDate = (value = new Date()): string => shanghaiBusinessDate(value);");
    expect(dashboard).toContain("reportingPageUrl(item.deepLink)");
    expect(query).not.toContain("canViewReports");
    expect(migration).not.toContain("dashboard:management:read");
    expect(migration).not.toContain("dashboard:site:read");
    expect(migration).toContain("report:view");
    expect(migration).toContain("report:export");
    expect(migration).not.toContain("('system_admin','report:");
  });
});
