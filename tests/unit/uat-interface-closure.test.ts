import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { businessFieldLabel, businessValue, formatBusinessCurrency, formatBusinessDecimal, formatBusinessMoney, translateTechnicalDetails } from "@dx-rework/contracts/business-display";
import { fixedBusinessCurrency } from "../../apps/web/src/fixed-business-currency.js";

const read = (path: string) => readFile(path, "utf8");

describe("UAT interface closure", () => {
  it("keeps work reporting inside the order-centered workflow", async () => {
    const [navigation, app] = await Promise.all([
      read("apps/web/src/components.tsx"),
      read("apps/web/src/App.tsx"),
    ]);
    expect(navigation).not.toContain('name: "返工上数"');
    expect(app).toMatch(/<Shell active="返工单看板" mobileNavigation="transaction">[^\n<]*<IeReworkReturn\/>\}<WorkReportingForm \/><\/Shell>/);
    expect(app).toContain('<WorkflowQueuePage active="返工单看板"');
  });

  it("keeps system management links in the expected sequence", async () => {
    const [navigation, employee, masterData] = await Promise.all([
      read("apps/web/src/system-management-navigation.tsx"),
      read("apps/web/src/employee-access-page.tsx"),
      read("apps/web/src/master-data-page.tsx"),
    ]);
    expect(navigation).toContain('pageUrl("ui/employee-access")');
    expect(navigation).toContain("人员与权限");
    expect(navigation).toContain("工厂、供应商、工艺与工序数据库");
    expect(navigation).toContain('pageUrl("ui/master-data")');
    expect(navigation).not.toContain('pageUrl("ui/process-database")');
    expect(navigation.indexOf("人员与权限")).toBeLessThan(navigation.indexOf("工厂、供应商、工艺与工序数据库"));
    expect(navigation).toContain("visibleTabs.map");
    expect(employee).toContain('<Shell active="人员与权限">');
    expect(employee).toContain('<SystemManagementNavigation active="employee-access" />');
    expect(employee).toContain("assignableRoles");
    expect(masterData).toContain('<SystemManagementNavigation active="master-data" />');
    expect(masterData).toContain('view === "crafts" ? "工艺数据库"');
    expect(masterData).toContain('view === "processes" ? "工序数据库"');
    expect(masterData).toContain('id="factories"');
    expect(masterData).toContain('id="processes"');
  });

  it("provides real wage search, period shortcuts, summaries, detail and export", async () => {
    const source = await read("apps/web/src/wages/wage-period-list.tsx");
    expect(source).toContain('loadReport("wages"');
    expect(source).toContain("工人 / 订单 / 款号 / 杂事");
    expect(source).toContain(">本月<");
    expect(source).toContain(">本季度<");
    expect(source).toContain(">本年度<");
    expect(source).toContain("按工人汇总");
    expect(source).toContain("逐单逐人工资明细");
    expect(source).toContain('reportExportUrl("wages", filters)');
    expect(source).not.toContain("15 秒自动刷新月结状态");
  });

  it("renders reports, nested audit details and totals in business Chinese", async () => {
    const [report, reportingStyles, admin, webDisplay] = await Promise.all([
      read("apps/web/src/reporting/report-center-page.tsx"),
      read("apps/web/src/reporting/reporting.css"),
      read("apps/web/src/admin-console-page.tsx"),
      read("apps/web/src/business-display.ts"),
    ]);
    expect(report).toContain("snapshotBusinessValue(column.key, row[column.key])");
    expect(report).toContain("businessFieldLabel(key)");
    expect(report).toContain("snapshotBusinessValue(key, total)");
    expect(report).toContain("isBusinessMoneyField(key)");
    expect(report).toContain("fixedBusinessCurrency(String(value))");
    expect(report).toContain("businessValue(key, value)");
    expect(report).not.toContain("Math.round(numeric)");
    expect(report).not.toContain('action="返回全部订单"');
    expect(report).not.toContain("数据快照：");
    expect(reportingStyles).toContain(".reporting-summary>div:last-child{justify-content:flex-start}");
    expect(reportingStyles).toContain(".reporting-filters,.report-center-filters,.workflow-queue-filters{grid-template-columns:minmax(0,1fr)}");
    expect(admin).toContain("businessActionLabel(event.action)");
    expect(admin).toContain("businessEntityLabel(event.entityType)");
    expect(webDisplay).toContain('@dx-rework/contracts/business-display');
    expect(businessFieldLabel("amount")).toBe("金额");
    expect(businessFieldLabel("exceptionCount")).toBe("异常数量");
    expect(businessValue("proposedAmount", "24.25")).toBe("¥24.25");
    expect(formatBusinessDecimal("2000")).toBe("2,000");
    expect(formatBusinessMoney("4.5000")).toBe("4.5");
    expect(formatBusinessCurrency("9000.00")).toBe("¥9,000");
    expect(businessValue("amount", "9000.00")).toBe("¥9,000");
    expect(fixedBusinessCurrency("0")).toBe("¥0.00");
    expect(fixedBusinessCurrency("2.5")).toBe("¥2.50");
    expect(fixedBusinessCurrency("10")).toBe("¥10.00");
    expect(fixedBusinessCurrency("0.5")).toBe("¥0.50");
    expect(fixedBusinessCurrency("0.6")).toBe("¥0.60");
    expect(fixedBusinessCurrency("9007199254740993.5")).toBe("¥9,007,199,254,740,993.50");
    expect(translateTechnicalDetails({
      expiresAt: "2026-08-11T00:00:00.000Z",
      boundEntityType: "rework_order",
      boundEntityId: "stable-id",
    })).toEqual({
      到期时间: expect.any(String),
      绑定业务对象: "返工单",
      绑定业务对象编号: "stable-id",
    });
  });

  it("collapses external deduction progress into the three management-card states", async () => {
    const [contract, shared, query, dto, card] = await Promise.all([
      read("packages/contracts/src/reporting.ts"),
      read("apps/api/src/reporting/management-reporting-shared.ts"),
      read("apps/api/src/reporting/management-reporting-orders.ts"),
      read("apps/api/src/reporting/management-reporting-dto.ts"),
      read("apps/web/src/reporting/management-order-card.tsx"),
    ]);
    expect(contract).toContain('deductionStatus: z.enum(["not_started", "not_deducted", "completed"])');
    expect(shared).toContain('deduction_status: ManagementReworkRow["deductionStatus"]');
    expect(query).toContain("bool_and(case_record.status='closed') all_closed");
    expect(query).toContain("WHEN order_record.status<>'completed' THEN 'not_started'");
    expect(query).toContain("WHEN external.all_closed THEN 'completed'");
    expect(query).toContain("ELSE 'not_deducted'");
    expect(dto).toContain("deductionStatus: row.deduction_status");
    expect(card).toContain('<dt>扣款状态</dt>');
    expect(card).toContain('not_started: "未开始"');
    expect(card).toContain('not_deducted: "未扣款"');
    expect(card).toContain('completed: "扣款完成"');
    expect(card).not.toContain("<dt>附件</dt>");
  });

  it("pins sidebar identity in the final loaded CSS layer", async () => {
    const [styles, workflow, main] = await Promise.all([
      read("apps/web/src/styles.css"),
      read("apps/web/src/workflow-shell.css"),
      read("apps/web/src/main.tsx"),
    ]);
    expect(styles).toContain("box-sizing: border-box; height: 100vh; height: 100dvh;");
    expect(styles).toContain(".app-shell__identity { margin-top: auto;");
    expect(workflow).toMatch(/\.app-shell \.org \{[\s\S]*?margin-top: auto;/);
    expect(workflow).not.toMatch(/\.app-shell \.org \{[\s\S]*?margin-top: 10px;/);
    expect(main.indexOf('"./workflow-shell.css"')).toBeGreaterThan(main.indexOf('"./styles.css"'));
  });

  it("keeps wage detail and download without adjustment controls or page navigation", async () => {
    const detail = await read("apps/web/src/wages/wage-period-detail.tsx");
    expect(detail).toContain("查看分摊计算");
    expect(detail).toContain("formatBusinessCurrency(item.payableAmount)");
    expect(detail).toContain("download");
    expect(detail).not.toContain("window.location.assign");
    expect(detail).not.toContain("发起工资调整");
    expect(detail).not.toContain("WageAdjustmentForm");
  });

  it("uses the shared Chinese vocabulary in report and wage workbooks", async () => {
    const [reportExport, wageExport, reportingShared] = await Promise.all([
      read("apps/api/src/reporting/report-export-service.ts"),
      read("apps/api/src/wages/wage-export-service.ts"),
      read("apps/api/src/reporting/management-reporting-shared.ts"),
    ]);
    expect(reportExport).toContain("exportCell(column.key");
    expect(reportExport).toContain("businessFieldLabel(key)");
    expect(reportExport).toContain("BUSINESS_TIME_ZONE");
    expect(reportExport).not.toContain("Asia/Singapore");
    expect(reportingShared).toContain("BUSINESS_TIME_ZONE");
    expect(reportingShared).not.toContain("Asia/Singapore");
    expect(wageExport).toContain('businessCellValue("personType"');
    expect(wageExport).toContain('businessCellValue("assignmentMode"');
    expect(wageExport).toContain("translateTechnicalDetails(line.member_snapshot)");
  });

  it("retires superseded payroll roles without deleting assignment history", async () => {
    const migration = await read("apps/api/migrations/0048_uat_systemic_closure.sql");
    expect(migration).toContain("role_code IN ('payroll_review', 'payroll_close')");
    expect(migration).toContain("SET enabled = false");
    expect(migration).not.toContain("DELETE FROM user_role_assignments");
  });
});
