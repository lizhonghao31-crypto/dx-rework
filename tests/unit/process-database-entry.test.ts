import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("process database entry", () => {
  it("exposes a dedicated process database page without coupling its load to suppliers", async () => {
    const [app, navigation, page, css] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/system-management-navigation.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.css", "utf8"),
    ]);

    expect(app).toContain('path === "/ui/process-database"');
    expect(app).toContain('<MasterDataPage view="processes" />');
    expect(app).toContain('path === "/ui/process-database" || path === "/ui/people"');
    expect(navigation).toContain('pageUrl("ui/process-database")');
    expect(navigation).toContain("工艺数据库");
    expect(page).toContain('view === "processes" ? "工艺数据库" : "工厂与供应商"');
    expect(page).toContain('view === "suppliers" ? <Surface');
    expect(page).toContain('view === "processes" ? <Surface');
    expect(page).toContain('if (view === "suppliers")');
    expect(page).toContain('json<ProcessPage>(processCatalogPath(appliedProcessSearch))');
    expect(css).toContain(".master-data-grid--single");
  });
});

