import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework query navigation", () => {
  it("returns non-report readers through role-aware landing instead of forcing management dashboard", async () => {
    const source = await readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8");
    expect(source).toContain('action={canViewReports ? "报表中心" : "返回工作台"}');
    expect(source).toContain('actionHref={canViewReports ? "/ui/reports" : "/"}');
  });
});
