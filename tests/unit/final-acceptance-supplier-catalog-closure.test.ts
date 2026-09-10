import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ACCEPTANCE_ROLE_MATRIX } from "../../apps/web/src/acceptance-matrix.js";

describe("final Acceptance supplier catalog closure", () => {
  it("removes generic supplier catalog capability only from QC and tail supervisor", async () => {
    const migration = await readFile(
      "apps/api/migrations/0168_final_acceptance_supplier_catalog_closure.sql",
      "utf8",
    );
    expect(migration).toContain("role_code IN ('quality_control','tail_supervisor')");
    expect(migration).toContain("capability='supplier_catalog:read'");
    expect(migration).not.toContain("order_merchandiser");
    expect(migration).not.toContain("production_management");
  });

  it("keeps QC and tail supplier-center expectations denied", () => {
    for (const alias of ["qc", "tail-supervisor"] as const) {
      const entry = ACCEPTANCE_ROLE_MATRIX.find((candidate) => candidate.alias === alias);
      expect(entry?.allowedModules).not.toContain("suppliers");
      expect(entry?.probes?.find((probe) => probe.id === "supplier-list")?.expectedStatus).toBe(403);
    }
  });
});
