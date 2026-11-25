import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing craft database separation", () => {
  it("keeps sourcing crafts independent from rework process configuration", async () => {
    const [
      migration,
      orderCraftMigration,
      service,
      sourcingService,
      sourcingRead,
      routes,
      sourcingPage,
      sourcingTransport,
      masterDataPage,
      requirement,
    ] = await Promise.all([
      readFile("apps/api/migrations/0134_versioned_craft_catalog.sql", "utf8"),
      readFile("apps/api/migrations/0135_sourcing_case_craft_snapshots.sql", "utf8"),
      readFile("apps/api/src/access/service.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-case-read.ts", "utf8"),
      readFile("apps/api/src/access/routes.ts", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-api-client.ts", "utf8"),
      readFile("apps/web/src/master-data-page.tsx", "utf8"),
      readFile("docs/requirements/startup-requirements-v1.2.md", "utf8"),
    ]);

    expect(migration).toContain("CREATE TABLE craft_catalog_versions");
    expect(migration).toContain("CREATE VIEW current_craft_catalog");
    expect(migration).toContain("migration_backfill");
    expect(migration).toContain("intentionally receive no reusable catalog version");
    expect(migration).toContain("craft_catalog_versions_guard_creation");
    expect(migration).not.toContain("FROM sourcing_cases");
    expect(migration).not.toContain("ALTER TABLE process_catalog_items");

    expect(orderCraftMigration).toContain("CREATE TABLE sourcing_case_crafts");
    expect(orderCraftMigration).toContain("sourcing_case_crafts_guard_creation");
    expect(orderCraftMigration).not.toContain("INSERT INTO sourcing_case_crafts");
    expect(sourcingService).toContain("JSON.stringify(selectedCrafts)");
    expect(sourcingService).toContain("所选工艺已停用或不存在");
    expect(sourcingService).toContain("readSourcingCaseList(this.database,actor");
    expect(sourcingRead).toContain("ORDER BY binding.position");

    expect(service).toContain("async listCrafts(");
    expect(service).toContain("async ensureCrafts(");
    expect(service).toContain("INSERT INTO craft_catalog_items");
    expect(service).toContain("INSERT INTO craft_catalog_versions");
    expect(service).toContain("async reviseCraft(");
    expect(service).toContain("async listCraftHistory(");
    expect(service).toContain("FROM current_process_catalog");

    expect(routes).toContain('app.get("/master-data/crafts"');
    expect(routes).toContain('app.post("/master-data/crafts/ensure"');
    expect(routes).toContain('app.post("/master-data/crafts/:craftId/versions"');
    expect(routes).toContain('app.get("/master-data/crafts/:craftId/history"');
    expect(routes).toContain('includes("order_merchandiser")');
    expect(routes).toContain('"sourcing:inquiry:create"');

    expect(sourcingPage).toContain('requestSubmission("master-data/crafts/ensure"');
    expect(sourcingPage).toMatch(/import\s*\{[^}]*\brequestSubmission\b[^}]*\}\s*from\s*"\.\/sourcing-api-client\.js"/);
    expect(sourcingTransport).toContain('return await request(path, schema, { ...init, signal: controller.signal });');
    expect(sourcingTransport).toContain('controller.abort()');
    expect(sourcingPage).toContain("craftNames: names");
    expect(sourcingPage).toContain("craftIds: crafts.map");
    expect(sourcingPage).not.toContain("processes: normalizedProcesses");
    expect(sourcingPage).toContain('list="sourcing-craft-options"');
    expect(sourcingPage).toContain('master-data/crafts?q=');
    expect(sourcingPage).toContain("activeCraftQuery");
    expect(sourcingPage).toContain("确认后进入合同第二条");

    expect(masterDataPage).toContain('view === "crafts" ? "工艺数据库"');
    expect(masterDataPage).toContain('view === "processes" ? "工序数据库"');
    expect(masterDataPage).toContain("维护返工使用的公共工序");
    expect(masterDataPage).toContain("外发跟单在创建订单时可直接录入新工艺");
    expect(masterDataPage).toContain("reviseCraft");
    expect(masterDataPage).toContain("版本 {craft.version}");
    expect(masterDataPage).toContain('{craft.active ? "停用" : "恢复"}');
    expect(requirement).toContain("工艺与工序为两套独立基础资料");
  });
});
