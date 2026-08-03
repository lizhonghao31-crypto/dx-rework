import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { buildWageWorkbook } from "../../apps/api/src/wages/wage-export-service.js";

describe("wage web and xlsx delivery", () => {
  it("builds a real deterministic XLSX zip with two worksheets", () => {
    const details = [["未锁定预览"], ["工资月份", "最终金额"], ["2026-07", "1.00"]];
    const summary = [["工人", "最终金额"], ["Worker", "1.00"]];
    const first = buildWageWorkbook(details, summary);
    const second = buildWageWorkbook(details, summary);
    expect(first.subarray(0, 2).toString()).toBe("PK");
    expect(first.equals(second)).toBe(true);
    expect(first.includes(Buffer.from("xl/worksheets/sheet1.xml"))).toBe(true);
    expect(first.includes(Buffer.from("xl/worksheets/sheet2.xml"))).toBe(true);
  });

  it("wires wage routes, live commands, evidence and exports", async () => {
    const [app, list, detail, adjustment] = await Promise.all([
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-period-list.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-period-detail.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/wages/wage-adjustment-form.tsx", import.meta.url), "utf8"),
    ]);
    expect(app).toContain('path === "/ui/wages"');
    expect(app).toContain('requiredCapability="wage:view"');
    expect(list).toContain("15_000");
    expect(list).toContain('window.addEventListener("focus"');
    expect(detail).toContain("administrative-approve");
    expect(detail).toContain("administrative-return");
    expect(detail).toContain("export.xlsx");
    expect(adjustment).toContain("ExternalEvidenceUploader");
    expect(adjustment).toContain('"idempotency-key": crypto.randomUUID()');
  });
});
