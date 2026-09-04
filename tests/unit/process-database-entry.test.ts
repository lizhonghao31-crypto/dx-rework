import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("process database entry", () => {
  it("makes the process database visible inside the combined master-data entry", async () => {
    const [app, navigation, page, css] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/system-management-navigation.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.css", "utf8"),
    ]);

    expect(app).not.toContain('path === "/ui/process-database"');
    expect(app).toContain('masterDataView === "suppliers"');
    expect(navigation).toContain("工厂、供应商、工艺与工序数据库");
    expect(app).toContain("<LegacySupplierCenterRedirect />");
    expect(app).toContain('parameters.get("tool") === "onboarding"');
    expect(app).toContain('<MasterDataPage view="suppliers" />');
    expect(app).toContain('<SupplierCenterPage mode="directory" />');
    expect(page).toContain('href={pageUrl("ui/suppliers")}>供应商中心</a>');
    expect(navigation).not.toContain('pageUrl("ui/process-database")');
    expect(page).toContain('view === "crafts" ? "工艺数据库" : view === "processes" ? "工序数据库" : "工厂与供应商"');
    expect(page).toContain('?view=crafts`}>工艺数据库</a>');
    expect(page).toContain('?view=processes`}>工序数据库</a>');
    expect(page).toContain('view === "crafts" ? <Surface');
    expect(page).toContain('view === "suppliers" ? <Surface');
    expect(page).toContain('view === "processes" ? <Surface');
    expect(page).toContain('if (view === "crafts")');
    expect(page).toContain('else if (view === "suppliers")');
    expect(page).toContain('json<ProcessPage>(processCatalogPath(appliedProcessSearch))');
    expect(css).toContain(".master-data-grid--single");
    expect(css).toContain(".master-data-view-tabs");
  });
});
