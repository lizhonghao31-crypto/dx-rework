import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("UAT interface closure", () => {
  it("keeps work reporting inside the order-centered workflow", async () => {
    const [navigation, app] = await Promise.all([
      read("apps/web/src/components.tsx"),
      read("apps/web/src/App.tsx"),
    ]);
    expect(navigation).not.toContain('name: "返工上数"');
    expect(app).toContain('<Shell active="全部订单"><WorkReportingForm /></Shell>');
    expect(app).toContain('<WorkflowQueuePage active="全部订单"');
  });

  it("exposes employee access from system management", async () => {
    const [admin, employee] = await Promise.all([
      read("apps/web/src/admin-console-page.tsx"),
      read("apps/web/src/employee-access-page.tsx"),
    ]);
    expect(admin).toContain('pageUrl("ui/employee-access")');
    expect(admin).toContain("员工权限管理");
    expect(employee).toContain('<Shell active="系统管理">');
    expect(employee).toContain("assignableRoles");
  });

  it("provides real wage search, period shortcuts, summaries, detail and export", async () => {
    const source = await read("apps/web/src/wages/wage-period-list.tsx");
    expect(source).toContain('loadReport("wages"');
    expect(source).toContain("工人 / 返工单 / 款号");
    expect(source).toContain(">本月<");
    expect(source).toContain(">本季度<");
    expect(source).toContain(">本年度<");
    expect(source).toContain("按工人汇总");
    expect(source).toContain("逐单逐人工资明细");
    expect(source).toContain('reportExportUrl("wages", filters)');
  });

  it("renders reports and system records in business Chinese", async () => {
    const [report, admin, display] = await Promise.all([
      read("apps/web/src/reporting/report-center-page.tsx"),
      read("apps/web/src/admin-console-page.tsx"),
      read("apps/web/src/business-display.ts"),
    ]);
    expect(report).toContain("businessValue(column.key, row[column.key])");
    expect(report).toContain("businessFieldLabel(key)");
    expect(admin).toContain("businessActionLabel(event.action)");
    expect(admin).toContain("businessEntityLabel(event.entityType)");
    expect(admin).toContain("businessFieldLabel(key)");
    expect(display).toContain('cancelled: "已取消"');
    expect(display).toContain('attachment_upload_not_completed: "附件上传未完成"');
  });

  it("shows ready attachment counts on every order card", async () => {
    const [contract, shared, query, dto, card] = await Promise.all([
      read("packages/contracts/src/reporting.ts"),
      read("apps/api/src/reporting/management-reporting-shared.ts"),
      read("apps/api/src/reporting/management-reporting-orders.ts"),
      read("apps/api/src/reporting/management-reporting-dto.ts"),
      read("apps/web/src/reporting/management-order-card.tsx"),
    ]);
    expect(contract).toContain("attachmentCount: z.number().int().nonnegative()");
    expect(shared).toContain("attachment_count: number");
    expect(query).toContain("attachment_count");
    expect(dto).toContain("attachmentCount: row.attachment_count");
    expect(card).toContain("点击订单查阅");
  });

  it("pins sidebar identity to the visible viewport", async () => {
    const styles = await read("apps/web/src/styles.css");
    expect(styles).toContain("box-sizing: border-box; height: 100vh; height: 100dvh;");
    expect(styles).toContain(".app-shell__identity { margin-top: auto;");
  });
});
