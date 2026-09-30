import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import { ReportExportService } from "../../apps/api/src/reporting/report-export-service.js";
import { registerManagementReportingRoutes } from "../../apps/api/src/reporting/management-reporting-routes.js";
import type { RootAuthority } from "../../apps/api/src/access/root-authority.js";

const seams = vi.hoisted(() => ({ facts: vi.fn(), financial: vi.fn() }));
vi.mock("../../apps/api/src/reporting/management-reporting-orders.js", () => ({ fetchFacts: seams.facts }));
vi.mock("../../apps/api/src/reporting/management-reporting-financial.js", () => ({ financial: seams.financial, currentExceptionCount: async () => 0 }));
vi.mock("../../apps/api/src/reporting/management-reporting-exceptions.js", () => ({ exceptions: async () => [] }));

const now = new Date("2026-09-12T00:00:00Z");
const commonCapabilities = ["dashboard:management:read", "dashboard:site:read", "report:view", "report:export", "work:report"];
function fixture(roles: string[], extraCaps = ["wage:view", "wage:export"], revoked = false, root = false, scoped = false) {
  seams.facts.mockResolvedValue({ rows: [{ rework_order_id: randomUUID(), rework_no: "RW-PR01", style_no: "STYLE", order_no: "ORDER",
    status: "in_progress", node: "N04", node_label: "制作中", node_entered_at: now, aging_seconds: "0", current_handler_user_id: null,
    planned_quantity: "10", reported_quantity: "3", wage_amount: "91.23", responsibility_amount: "2.00", own_factory_amount: "0.00",
    external_proposed_amount: "0.00", external_deducted_amount: "0.00", external_remaining_amount: "0.00", deduction_status: "not_started",
    overdue: false, exception_count: 0, attachment_count: 0, updated_at: now, total_count: "1" }] });
  seams.financial.mockResolvedValue({ wageTotal: "91.23", responsibilityTotal: "2.00", ownFactoryTotal: "0.00", externalProposed: "0.00", externalDeducted: "0.00", externalRemaining: "0.00" });
  const query = vi.fn(async (sql: string) => {
    if (revoked && sql.includes("finance_authorized_wage_roles")) throw Object.assign(new Error("revoked"), { code: "42501" });
    if (sql.includes("CURRENT_TIMESTAMP as_of")) return { rows: [{ as_of: now, from_date: "2026-09-01", to_date: "2026-09-30" }] };
    return { rows: [] };
  });
  const db = { query, connect: async () => ({ query, release: vi.fn() }) } as unknown as Pool;
  const app = Fastify(), service = new ManagementReportingService(db);
  registerManagementReportingRoutes(app, { service, exportService: new ReportExportService(service, db, "test"),
    authenticate: async () => ({ id: randomUUID(), businessRoles: roles, capabilities: [...(scoped ? ["work:report"] : commonCapabilities), ...extraCaps] }),
    root: { isRootUser: async () => root } as unknown as RootAuthority });
  return { app, query };
}

describe("shared reporting routes preserve operations while withholding wage fields", () => {
  it.each(["tail_supervisor", "worker", "sample_designer", "order_merchandiser", "system_admin"])("redacts all shared JSON wage surfaces for %s despite legacy wage grants", async role => {
    const { app } = fixture([role]);
    for (const url of ["/site/dashboard", "/management/dashboard", "/management/rework-orders", "/management/reports/rework_overview"]) {
      const response = await app.inject({ url });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.body).not.toContain("91.23");
      expect(response.body).not.toMatch(/wageAmount|wageTotal|pendingWageReview|review_wages/);
      expect(response.body).toContain("RW-PR01");
      expect(response.body).toContain("2.00");
    }
    await app.close();
  });
  it("keeps a worker's status-scoped work list accessible without wage totals", async () => {
    const { app } = fixture(["worker"], [], false, false, true);
    const response = await app.inject({ url: "/management/rework-orders?status=in_progress" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0]).toMatchObject({ reworkNo: "RW-PR01", reportedQuantity: "3" });
    expect(response.json().items[0]).not.toHaveProperty("wageAmount");
    expect(seams.facts).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workTaskActorUserId: expect.any(String) }));
    await app.close();
  });
  it.each(["owner_group", "production_management", "finance_director", "wage_month_close_accountant", "finance_read"])("retains allowed shared wages for %s and hides them after persisted revocation", async role => {
    for (const revoked of [false, true]) {
      const { app, query } = fixture([role], ["wage:view", "wage:export"], revoked);
      for (const url of ["/site/dashboard", "/management/dashboard", "/management/rework-orders", "/management/reports/rework_overview"]) {
        const response = await app.inject({ url });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.body.includes("91.23")).toBe(!revoked);
      }
      expect(query).toHaveBeenCalledWith("SELECT finance_authorized_wage_roles($1,$2)", [expect.any(String), "wage:view"]);
      await app.close();
    }
  });
  it("requires separate wage export authority inside the general overview workbook", async () => {
    for (const canExport of [false, true]) {
      const { app } = fixture(["production_management"], ["wage:view", ...(canExport ? ["wage:export"] : [])]);
      const response = await app.inject({ url: "/management/reports/rework_overview/export.xlsx" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.rawPayload.includes(Buffer.from("工资金额"))).toBe(canExport);
      expect(response.rawPayload.includes(Buffer.from("91.23"))).toBe(canExport);
      expect(response.rawPayload.includes(Buffer.from("RW-PR01"))).toBe(true);
      await app.close();
    }
  });
  it("preserves Root without assigning ordinary wage roles or capabilities", async () => {
    const { app } = fixture([], [], false, true);
    const response = await app.inject({ url: "/management/rework-orders" });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0].wageAmount).toBe("91.23");
    await app.close();
  });
});
