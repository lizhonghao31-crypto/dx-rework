import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing craft database separation", () => {
  it("keeps sourcing crafts independent from rework process configuration", async () => {
    const [migration, service, routes, sourcingPage, masterDataPage, requirement] = await Promise.all([
      readFile("apps/api/migrations/0133_sourcing_craft_catalog.sql", "utf8"),
      readFile("apps/api/src/access/service.ts", "utf8"),
      readFile("apps/api/src/access/routes.ts", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.tsx", "utf8"),
      readFile("docs/requirements/startup-requirements-v1.2.md", "utf8"),
    ]);

    expect(migration).toContain("CREATE TABLE craft_catalog_items");
    expect(migration).toContain("FROM sourcing_cases");
    expect(migration).toContain("unnest(sourcing_case.process_items)");
    expect(migration).not.toContain("CREATE VIEW craft_catalog_items AS");
    expect(migration).not.toContain("ALTER TABLE process_catalog_items");

    expect(service).toContain("async listCrafts(");
    expect(service).toContain("async ensureCrafts(");
    expect(service).toContain("INSERT INTO craft_catalog_items");
    expect(service).toContain("FROM current_process_catalog");

    expect(routes).toContain('app.get("/master-data/crafts"');
    expect(routes).toContain('app.post("/master-data/crafts/ensure"');
    expect(routes).toContain('includes("order_merchandiser")');
    expect(routes).toContain('"sourcing:inquiry:create"');

    expect(sourcingPage).toContain('request("master-data/crafts/ensure"');
    expect(sourcingPage).toContain("craftNames: normalizedProcesses");
    expect(sourcingPage).toContain("processes: normalizedProcesses");
    expect(sourcingPage).toContain('list="sourcing-craft-options"');
    expect(sourcingPage).toContain("提交订单时自动写入工艺数据库");

    expect(masterDataPage).toContain('view === "crafts" ? "工艺数据库"');
    expect(masterDataPage).toContain('view === "processes" ? "工序数据库"');
    expect(masterDataPage).toContain("维护返工使用的公共工序");
    expect(masterDataPage).toContain("外发跟单在创建订单时可直接录入新工艺");
    expect(requirement).toContain("工艺与工序为两套独立基础资料");
  });
});
