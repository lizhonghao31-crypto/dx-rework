import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("external responsibility UI contract", () => {
  it("uses order-scoped supplier options instead of the generic master-data catalog", async () => {
    const source = await readFile("apps/web/src/external-responsibility-panel.tsx", "utf8");
    expect(source).toContain("external-responsibilities/supplier-options");
    expect(source).not.toContain('apiUrl("master-data/suppliers")');
    expect(source).toContain("if (response.status === 403) return [] as Supplier[];");
  });

  it("records deductions using the Shanghai business date", async () => {
    const source = await readFile("apps/web/src/external-responsibility-panel.tsx", "utf8");
    expect(source).toContain("deductedOn: shanghaiBusinessDate()");
    expect(source).not.toContain("toISOString().slice(0, 10)");
  });
});
