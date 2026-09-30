import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWageRoutes } from "../../apps/api/src/wages/wage-routes.js";
import { registerManagementReportingRoutes } from "../../apps/api/src/reporting/management-reporting-routes.js";
import type { WageService } from "../../apps/api/src/wages/wage-service.js";
import type { WageExportService } from "../../apps/api/src/wages/wage-export-service.js";
import type { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import type { ReportExportService } from "../../apps/api/src/reporting/report-export-service.js";
import type { RootAuthority } from "../../apps/api/src/access/root-authority.js";

const id = randomUUID();
const capabilities = ["wage:view", "wage:export", "wage:settlement_mark", "report:view", "report:export"];
const paths = ["/wage-periods", `/wage-periods/${id}`, `/wage-periods/${id}/items`, `/wage-items/${id}`,
  `/wage-periods/${id}/export.xlsx`, "/management/reports/wages", "/management/reports/wages/export.xlsx"];

function fixture(roles: string[], caps = capabilities, root = false) {
  const app = Fastify();
  const user = { id, businessRoles: roles, capabilities: caps };
  const authenticate = vi.fn(async () => user);
  const rootAuthority = { isRootUser: vi.fn(async () => root) } as unknown as RootAuthority;
  const wages = { list: vi.fn(async () => []), get: vi.fn(async () => ({ items: [] })), item: vi.fn(async () => ({})) };
  const exported = { export: vi.fn(async () => ({ filename: "test.xlsx", content: Buffer.from("PK-test") })) };
  const reporting = {
    report: vi.fn(async () => ({ reportType: "wages", asOf: "2026-09-12T00:00:00Z",
      range: { from: "2026-09-01", to: "2026-09-30", timezone: "Asia/Shanghai" },
      rowCount: 0, truncated: false, canExport: true, totals: {}, columns: [], rows: [] })),
    previewWageSettlement: vi.fn(async () => ({ lineIds: [], lineCount: 0, personCount: 0 })),
    markWageSettlement: vi.fn(async () => ({ markedCount: 0 })),
  };
  registerWageRoutes(app, { authenticate, root: rootAuthority, service: wages as unknown as WageService, exportService: exported as unknown as WageExportService });
  registerManagementReportingRoutes(app, { authenticate, root: rootAuthority, service: reporting as unknown as ManagementReportingService, exportService: exported as unknown as ReportExportService });
  return { app, wages, reporting, exported };
}

describe("finance wage access at every HTTP boundary", () => {
  it.each(["worker", "tail_supervisor", "pattern_room_supervisor", "sample_designer", "order_merchandiser", "warehouse_receiver", "system_admin"])(
    "rejects %s even with old/delegated wage and report capabilities", async role => {
      const f = fixture([role]);
      for (const path of [...paths, "/management/wages/settlement-preview"]) {
        expect((await f.app.inject({ method: "GET", url: path })).statusCode, path).toBe(403);
      }
      expect((await f.app.inject({ method: "POST", url: "/management/wages/settlement", payload: { filters: { limit: 100 }, lineIds: [id] } })).statusCode).toBe(403);
      expect(f.wages.list).not.toHaveBeenCalled();
      expect(f.reporting.report).not.toHaveBeenCalled();
      expect(f.exported.export).not.toHaveBeenCalled();
      expect(f.reporting.markWageSettlement).not.toHaveBeenCalled();
      await f.app.close();
    },
  );

  it.each(["owner_group", "production_management", "finance_director", "wage_month_close_accountant", "finance_read"])(
    "allows %s to view/export while keeping marker rights separate", async role => {
      const f = fixture([role]);
      for (const path of paths) expect((await f.app.inject({ method: "GET", url: path })).statusCode, path).toBe(200);
      const expected = ["owner_group", "production_management"].includes(role) ? 403 : 200;
      expect((await f.app.inject({ method: "GET", url: "/management/wages/settlement-preview" })).statusCode).toBe(expected);
      expect((await f.app.inject({ method: "POST", url: "/management/wages/settlement", payload: { filters: { limit: 100 }, lineIds: [id] } })).statusCode).toBe(expected);
      await f.app.close();
    },
  );

  it("merges actual roles and preserves independently verified Root abilities", async () => {
    for (const f of [fixture(["owner_group", "wage_month_close_accountant"]), fixture(["worker"], [], true)]) {
      for (const path of [...paths, "/management/wages/settlement-preview"]) expect((await f.app.inject({ method: "GET", url: path })).statusCode, path).toBe(200);
      await f.app.close();
    }
  });

  it("does not fall back to report:view or treat a role as a missing capability", async () => {
    const f = fixture(["finance_read"], ["report:view"]);
    expect((await f.app.inject({ method: "GET", url: "/management/reports/wages" })).statusCode).toBe(403);
    expect(f.reporting.report).not.toHaveBeenCalled();
    await f.app.close();
  });
});
