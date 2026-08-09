import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import { ReportExportService } from "../../apps/api/src/reporting/report-export-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("PR-14 management reporting PostgreSQL integration", () => {
  const schema = `management_reporting_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const ids = { owner: randomUUID(), tail: randomUUID(), admin: randomUUID(), worker: randomUUID() };
  let service: ManagementReportingService;

  const actor = (id: string, roles: string[], primary: string, capabilities: string[]): TrustedActorContext => ({
    actorId: id,
    actorRoles: roles,
    authorizationCapability: primary,
    authorizationCapabilities: capabilities,
    requestId: `report-${randomUUID()}`,
  });
  const ownerCapabilities = [
    "dashboard:management:read", "report:view", "report:export", "responsibility:determine", "own_factory:approve", "external_responsibility:view", "wage:view",
  ];
  const owner = () => actor(ids.owner, ["owner_group"], "dashboard:management:read", ownerCapabilities);
  const ownerExporter = () => actor(ids.owner, ["owner_group"], "report:export", ownerCapabilities);
  const tail = () => actor(ids.tail, ["tail_supervisor"], "dashboard:site:read", [
    "dashboard:site:read", "process:configure", "work:assign", "submission:audit", "wage:tail_review",
  ]);
  const worker = () => actor(ids.worker, ["worker"], "work:report", ["work:report"]);

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const directory = new URL("../../apps/api/migrations/", import.meta.url);
    const migrations = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toBe("0041_root_wage_decider_constraint.sql");
    for (const migration of migrations) await database.query(await readFile(new URL(migration, directory), "utf8"));

    for (const [id, name, role] of [
      [ids.owner, "Reporting owner", "owner_group"],
      [ids.tail, "Reporting tail", "tail_supervisor"],
      [ids.admin, "Reporting admin", "system_admin"],
      [ids.worker, "Reporting worker", "worker"],
    ] as const) {
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, name]);
      await database.query(
        `INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
         VALUES($1,$2,'dingtalk','report-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), id, `ding-${id}`, `union-${id}`],
      );
      await database.query(
        `INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
         VALUES($1,$2,$3,$2,'controlled reporting fixture')`,
        [randomUUID(), id, role],
      );
    }
    await new AccessMasterDataService(database, "report-corp").ensureOrganizationPolicy();
    service = new ManagementReportingService(database);
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("grants management reports only to management and finance roles", async () => {
    const capabilities = await database.query<{ role_code: string; capability: string }>(
      `SELECT role_code,capability FROM role_capabilities
       WHERE capability IN ('report:view','report:export') ORDER BY role_code,capability`,
    );
    expect(capabilities.rows).toEqual([
      { role_code: "finance_read", capability: "report:export" },
      { role_code: "finance_read", capability: "report:view" },
      { role_code: "owner_group", capability: "report:export" },
      { role_code: "owner_group", capability: "report:view" },
      { role_code: "production_management", capability: "report:export" },
      { role_code: "production_management", capability: "report:view" },
    ]);
    expect((await database.query("SELECT 1 FROM role_capabilities WHERE role_code='tail_supervisor' AND capability LIKE 'report:%'")).rowCount).toBe(0);
    expect((await database.query("SELECT 1 FROM role_capabilities WHERE role_code='system_admin' AND capability LIKE 'report:%'")).rowCount).toBe(0);
    expect((await database.query("SELECT 1 FROM role_capabilities WHERE role_code='owner_group' AND capability='dashboard:management:read'")).rowCount).toBe(1);
    expect((await database.query("SELECT 1 FROM role_capabilities WHERE role_code='tail_supervisor' AND capability='dashboard:site:read'")).rowCount).toBe(1);
  });

  it("executes dashboards, unified query and every report against the complete empty schema", async () => {
    const management = await service.managementDashboard(owner(), {});
    const site = await service.siteDashboard(tail(), {});
    const page = await service.listReworkOrders(owner(), { limit: 25 });
    expect(management.kpis).toEqual({ openOrders: 0, completedOrders: 0, overdueTodos: 0, exceptionCount: 0 });
    expect(management.financial).toEqual({ wageTotal: "0.00", responsibilityTotal: "0.00", ownFactoryTotal: "0.00", externalProposed: "0.00", externalDeducted: "0.00", externalRemaining: "0.00" });
    expect(site.kpis.pendingWageReview).toBe(0);
    expect(site.nodeCounts).toContainEqual({ node: "N10-A", label: "待工资初核", count: 0 });
    expect(page).toMatchObject({ items: [], nextCursor: null, canViewReports: true });

    for (const reportType of ["rework_overview", "wages", "responsibilities", "own_factory", "external_deductions", "exceptions"] as const) {
      const preview = await service.report(owner(), reportType, { limit: 100 });
      expect(preview).toMatchObject({ reportType, rowCount: 0, truncated: false, rows: [] });
      const exported = await service.exportData(owner(), reportType, { limit: 100 });
      expect(exported.data.rows).toEqual([]);
    }
  });

  it("lets operational roles read only a status-scoped workflow queue without report access", async () => {
    const page = await service.listReworkOrders(worker(), { status: "in_progress", limit: 25 });
    expect(page).toMatchObject({ items: [], nextCursor: null, canViewReports: false });
    await expect(service.listReworkOrders(worker(), { limit: 25 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(service.listReworkOrders(worker(), { status: "pending_order_review", limit: 25 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps site users out of management reports and records every successful export", async () => {
    await expect(service.report(tail(), "wages", { limit: 100 })).rejects.toMatchObject({ code: "FORBIDDEN" });

    const result = await new ReportExportService(service, database, "test-git-sha").export(
      ownerExporter(),
      "rework_overview",
      { from: "2026-08-01", to: "2026-08-31", q: "测试", limit: 100 },
    );
    expect(result.filename).toBe("返工总览-2026-08-01-2026-08-31.xlsx");
    expect(result.content.subarray(0, 2).toString()).toBe("PK");

    const audit = await database.query<{
      action: string;
      actor_id: string;
      authorization_capability: string;
      after_state: Record<string, unknown>;
    }>(
      `SELECT action,actor_id,authorization_capability,after_state
       FROM operation_events WHERE action='report.exported' ORDER BY created_at DESC,event_id DESC LIMIT 1`,
    );
    expect(audit.rows[0]).toMatchObject({
      action: "report.exported",
      actor_id: ids.owner,
      authorization_capability: "report:export",
      after_state: {
        reportType: "rework_overview",
        filters: { from: "2026-08-01", to: "2026-08-31", q: "测试", limit: 100 },
        range: { from: "2026-08-01", to: "2026-08-31" },
        rowCount: 0,
        filename: "返工总览-2026-08-01-2026-08-31.xlsx",
      },
    });
    expect(audit.rows[0]?.after_state.snapshotAt).toEqual(expect.any(String));
  });

  it("rejects report access when the claimed capability is absent even for system_admin", async () => {
    const systemAdmin = actor(ids.admin, ["system_admin"], "report:view", ["dashboard:management:read"]);
    const page = await service.listReworkOrders(systemAdmin, { limit: 25 });
    expect(page.canViewReports).toBe(false);
    await expect(service.report(systemAdmin, "rework_overview", { limit: 100 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(service.report(owner(), "wages", { status: "approved", limit: 100 })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
