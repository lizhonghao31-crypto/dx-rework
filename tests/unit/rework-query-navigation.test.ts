import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework query navigation", () => {
  it("keeps order lookup in the primary order center and returns report readers to financial reports", async () => {
    const source = await readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8");

    expect(source).toContain('<Shell active="全部订单">');
    expect(source).toContain('title="全部订单"');
    expect(source).toContain('action={canViewReports ? "财务报表" : "返回工作台"}');
    expect(source).toContain('actionHref={canViewReports ? "/ui/reports" : "/"}');
  });
});
