import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import {
  assertBusinessExportAllowed,
  assertWageDataExportAllowed,
} from "../../apps/api/src/access/export-authority.js";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

const expectAllowed = (run: () => void) => expect(run).not.toThrow();
const expectDenied = (run: () => void) => expect(run).toThrowError(/无权导出业务数据/);

describe("global export permission closure", () => {
  it("keeps the fixed generic export allowlist and wage-only exception exact", () => {
    for (const role of ["root_superuser", "owner_group", "production_management", "finance_director"]) {
      expectAllowed(() => assertBusinessExportAllowed([role], "receiving:export"));
      expectAllowed(() => assertBusinessExportAllowed([role], "report:export"));
    }
    for (const role of ["warehouse_receiver", "tail_supervisor", "finance_read", "system_admin", "worker", "ie_reviewer"]) {
      expectDenied(() => assertBusinessExportAllowed([role], "receiving:export"));
    }

    for (const role of ["root_superuser", "owner_group", "finance_director", "wage_month_close_accountant"]) {
      expectAllowed(() => assertWageDataExportAllowed([role]));
    }
    for (const role of ["production_management", "finance_read", "administrative_clerk", "tail_supervisor", "worker"]) {
      expectDenied(() => assertWageDataExportAllowed([role]));
    }
  });

  it("normalizes persisted export grants to the approved role sets", async () => {
    const migration = await read("apps/api/migrations/0164_global_export_allowlist.sql");
    expect(migration).toContain("role_code NOT IN ('owner_group','production_management','finance_director')");
    expect(migration).toContain("('finance_director','receiving:export')");
    expect(migration).toContain("('finance_director','report:export')");
    expect(migration).toContain("role_code NOT IN ('owner_group','finance_director','wage_month_close_accountant')");
    expect(migration).toContain("('wage_month_close_accountant','wage:export')");
    expect(migration).not.toContain("('warehouse_receiver','receiving:export')");
    expect(migration).not.toContain("('tail_supervisor','receiving:export')");
    expect(migration).not.toContain("('finance_read','report:export')");
    expect(migration).not.toContain("('finance_read','wage:export')");
    expect(migration).not.toContain("('production_management','wage:export')");
  });

  it("guards every current business-data export surface at route and service boundaries", async () => {
    const [authority, receiving, reports, wages, toolsRoutes, toolsService] = await Promise.all([
      read("apps/api/src/access/business-authority.ts"),
      read("apps/api/src/receiving/receiving-service.ts"),
      read("apps/api/src/reporting/report-export-service.ts"),
      read("apps/api/src/wages/wage-export-service.ts"),
      read("apps/api/src/tools/routes.ts"),
      read("apps/api/src/tools/exports.ts"),
    ]);

    expect(authority).toContain('capability.endsWith(":export")');
    expect(authority).toContain("assertBusinessExportAllowed(actorRoles, capability)");
    expect(receiving).toContain('this.assertBoardOperator(actor, "receiving:export")');
    expect(reports).toContain('assertBusinessExportAllowed(actor.actorRoles, "report:export")');
    expect(reports).toContain("assertWageDataExportAllowed(actor.actorRoles)");
    expect(wages).toContain("assertWageDataExportAllowed(actor.actorRoles)");
    expect(toolsRoutes).toContain('assertBusinessExportAllowed(authenticated.trusted.actorRoles,"tools:export")');
    expect(toolsRoutes).toContain('binding.entityType==="export_job"');
    expect(toolsService).toContain('assertBusinessExportAllowed(actor.actorRoles,"tools:export")');
  });

  it("does not treat blank import templates as business-data exports", async () => {
    const masterData = await read("apps/web/src/master-data-page.tsx");
    expect(masterData).toContain("downloadSupplierTemplate");
    expect(masterData).toContain("downloadProcessTemplate");
    expect(masterData).not.toContain("exportSupplierData");
    expect(masterData).not.toContain("exportProcessData");
  });
});
