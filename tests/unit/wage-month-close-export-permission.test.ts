import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");

describe("wage month-close accountant export permission", () => {
  it("keeps the approved rule, DB grant, UI label and existing export gate aligned", async () => {
    const [rule, migration, shell, display, page] = await Promise.all([
      read("docs/requirements/platform-permission-golden-source-v1.0.md"),
      read("apps/api/migrations/0163_wage_month_close_accountant_export.sql"),
      read("apps/web/src/components.tsx"),
      read("packages/contracts/src/business-display.ts"),
      read("apps/web/src/wages/wage-period-list.tsx"),
    ]);

    expect(rule).toContain("PERM-WAGE-MONTH-CLOSE-EXPORT-001");
    expect(rule).toContain("工资月结会计仅允许导出工资明细");
    expect(migration).toContain("('wage_month_close_accountant','wage:export')");
    expect(shell).toContain('wage_month_close_accountant: "工资月结会计"');
    expect(display).toContain('wage_month_close_accountant: "工资月结会计"');
    expect(page).toContain('value?.canExport ? <a href={reportExportUrl("wages", filters)}');
    expect(page).toContain("导出当前工资明细");
  });
});
