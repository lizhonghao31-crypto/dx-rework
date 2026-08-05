import { randomUUID } from "node:crypto";

import { loadConfig } from "@dx-rework/config";
import type {
  ManagementDashboardResponse,
  ManagementReworkPage,
  ReportPreviewResponse,
  SiteDashboardResponse,
} from "@dx-rework/contracts/reporting";
import { describe, expect, it, vi } from "vitest";

import { buildApp } from "../../apps/api/src/app.js";
import type { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import type { ReportExportService } from "../../apps/api/src/reporting/report-export-service.js";

const config = loadConfig({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://test:test@localhost/test",
  DINGTALK_CORP_ID: "corp",
  DINGTALK_H5_APP_KEY: "key",
  DINGTALK_H5_APP_SECRET: "secret",
  DINGTALK_WEB_CLIENT_ID: "web",
  DINGTALK_WEB_CLIENT_SECRET: "secret",
  DINGTALK_QR_REDIRECT_URI: "https://example.test/callback",
  SESSION_SECRET: "a-test-session-secret-with-at-least-32-characters",
});
const actorId = randomUUID();
const orderId = randomUUID();
const now = "2026-08-05T00:00:00.000Z";
const order = {
  reworkOrderId: orderId,
  reworkNo: "RW-20260805-001",
  styleNo: "STYLE-001",
  orderNo: "ORDER-001",
  status: "in_progress" as const,
  node: "N05",
  nodeLabel: "返工上数中",
  nodeEnteredAt: now,
  agingSeconds: 60,
  currentHandlerUserId: actorId,
  plannedQuantity: "10",
  reportedQuantity: "5.00",
  wageAmount: "5.00",
  responsibilityAmount: "0.00",
  ownFactoryAmount: "0.00",
  externalProposedAmount: "0.00",
  externalDeductedAmount: "0.00",
  externalRemainingAmount: "0.00",
  overdue: false,
  exceptionCount: 0,
  deepLink: `/ui/tasks/${orderId}`,
  updatedAt: now,
};
const management: ManagementDashboardResponse = {
  mode: "management",
  asOf: now,
  range: { from: "2026-08-01", to: "2026-08-31", timezone: "Asia/Singapore" },
  kpis: { openOrders: 1, completedOrders: 0, overdueTodos: 0, exceptionCount: 0 },
  nodeCounts: [{ node: "N05", label: "返工上数中", count: 1 }],
  financial: { wageTotal: "5.00", responsibilityTotal: "0.00", ownFactoryTotal: "0.00", externalProposed: "0.00", externalDeducted: "0.00", externalRemaining: "0.00" },
  exceptions: [],
  recentOrders: [order],
  availableActions: ["view_rework", "export_reports"],
};
const site: SiteDashboardResponse = {
  mode: "site",
  asOf: now,
  range: management.range,
  kpis: { pendingConfiguration: 0, pendingAssignment: 0, inProgress: 1, pendingOrderReview: 0, pendingWageReview: 0, siteExceptions: 0 },
  nodeCounts: [{ node: "N05", label: "返工上数中", count: 1 }],
  recentOrders: [order],
  availableActions: ["assign_work", "export_reports"],
};
const page: ManagementReworkPage = { asOf: now, items: [order], nextCursor: null, canViewReports: true };
const preview: ReportPreviewResponse = {
  reportType: "rework_overview",
  asOf: now,
  range: management.range,
  rowCount: 1,
  truncated: false,
  canExport: true,
  totals: { wageAmount: "5.00" },
  columns: [{ key: "reworkNo", label: "返工单号" }],
  rows: [{ reworkNo: "RW-20260805-001" }],
};

function testApp() {
  const service = {
    managementDashboard: vi.fn().mockResolvedValue(management),
    siteDashboard: vi.fn().mockResolvedValue(site),
    listReworkOrders: vi.fn().mockResolvedValue(page),
    report: vi.fn().mockResolvedValue(preview),
  };
  const exportService = { export: vi.fn().mockResolvedValue({ filename: "返工总览.xlsx", content: Buffer.from("PK-test") }) };
  const authenticate = vi.fn().mockResolvedValue({
    id: actorId,
    businessRoles: ["owner_group"],
    capabilities: ["dashboard:management:read", "dashboard:site:read", "report:view", "report:export"],
  });
  const app = buildApp({
    config,
    checkDatabase: vi.fn(),
    getAppliedSchemaHistory: vi.fn(),
    reporting: {
      authenticate,
      service: service as unknown as ManagementReportingService,
      exportService: exportService as unknown as ReportExportService,
    },
  });
  return { app, service, exportService };
}

describe("management reporting routes", () => {
  it("serves management/site dashboards, current queries, previews and XLSX", async () => {
    const { app, service, exportService } = testApp();
    const [managementResponse, siteResponse, ordersResponse, reportResponse, exportResponse] = await Promise.all([
      app.inject({ method: "GET", url: "/management/dashboard?from=2026-08-01&to=2026-08-31" }),
      app.inject({ method: "GET", url: "/site/dashboard" }),
      app.inject({ method: "GET", url: "/management/rework-orders?status=in_progress&limit=25" }),
      app.inject({ method: "GET", url: "/management/reports/rework_overview?limit=100" }),
      app.inject({ method: "GET", url: "/management/reports/rework_overview/export.xlsx" }),
    ]);
    expect(managementResponse.statusCode).toBe(200);
    expect(managementResponse.json()).toEqual(management);
    expect(siteResponse.json()).toEqual(site);
    expect(ordersResponse.json()).toEqual(page);
    expect(reportResponse.json()).toEqual(preview);
    expect(exportResponse.statusCode).toBe(200);
    expect(exportResponse.headers["content-type"]).toContain("spreadsheetml.sheet");
    expect(service.managementDashboard).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "dashboard:management:read" }), { from: "2026-08-01", to: "2026-08-31" });
    expect(service.listReworkOrders).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: "in_progress", limit: 25 }));
    expect(exportService.export).toHaveBeenCalledWith(expect.objectContaining({ authorizationCapability: "report:export" }), "rework_overview", expect.objectContaining({ limit: 100 }));
    await app.close();
  });

  it("rejects unknown report types, extra fields and inverted ranges", async () => {
    const { app } = testApp();
    const [unknown, extra, inverted, tooLarge] = await Promise.all([
      app.inject({ method: "GET", url: "/management/reports/not-real" }),
      app.inject({ method: "GET", url: "/management/dashboard?extra=true" }),
      app.inject({ method: "GET", url: "/management/dashboard?from=2026-08-02&to=2026-08-01" }),
      app.inject({ method: "GET", url: "/management/rework-orders?limit=101" }),
    ]);
    expect(unknown.statusCode).toBe(400);
    expect(extra.statusCode).toBe(400);
    expect(inverted.statusCode).toBe(400);
    expect(tooLarge.statusCode).toBe(400);
    await app.close();
  });
});
