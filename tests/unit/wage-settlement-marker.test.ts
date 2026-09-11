import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { ReportQuerySchema } from "@dx-rework/contracts/reporting";

const read = (path: string) => readFile(path, "utf8");

describe("wage settlement marker", () => {
  it("accepts only the two supported worker types", () => {
    expect(ReportQuerySchema.parse({ personType: "internal" }).personType).toBe("internal");
    expect(ReportQuerySchema.parse({ personType: "temporary" }).personType).toBe("temporary");
    expect(ReportQuerySchema.safeParse({ personType: "other" }).success).toBe(false);
  });

  it("keeps settlement marking separate from legacy month-close state", async () => {
    const [migration, report, routes, service] = await Promise.all([
      read("apps/api/migrations/0171_wage_settlement_marker.sql"),
      read("apps/api/src/reporting/management-reporting-report-wages.ts"),
      read("apps/api/src/wages/wage-routes.ts"),
      read("apps/api/src/wages/wage-service.ts"),
    ]);
    expect(migration).toContain("CREATE TABLE rework_wage_settlement_marks");
    expect(migration).toContain("'wage:settlement_mark'");
    expect(report).toContain("settlementStatus");
    expect(report).not.toContain('{ key: "periodStatus", label: "月结状态" }');
    expect(report).toContain("report.completed_at");
    expect(report).toContain("query.personType");
    expect(routes).toContain('"/wage-settlements/summary"');
    expect(routes).toContain('"/wage-settlements"');
    expect(service).toContain("count(DISTINCT wage.person_id)");
    expect(service).toContain("ON CONFLICT(wage_item_id) DO NOTHING");
  });

  it("keeps the wage UI compact and groups people by stable identity", async () => {
    const page = await read("apps/web/src/wages/wage-period-list.tsx");
    const css = await read("apps/web/src/wages/wage-period-list.css");
    expect(page).toContain('option value="internal">正式工');
    expect(page).toContain('option value="temporary">临时工');
    expect(page).toContain("row.personId ?? row.personName");
    expect(page).toContain("工资已结清");
    expect(page).toContain("确认工资已结清");
    expect(page).toContain('column.key === "settlementStatus"');
    expect(css).toContain(".wage-query-actions");
    expect(css).toContain("margin-left: auto");
  });
});
