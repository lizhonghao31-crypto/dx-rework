import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ACCEPTANCE_ROLE_MATRIX } from "../../apps/web/src/acceptance-matrix.js";

describe("final Acceptance Lab permission closure", () => {
  it("removes only the three legacy over-grants found by the approved matrix", async () => {
    const migration = await readFile(
      "apps/api/migrations/0167_final_acceptance_permission_closure.sql",
      "utf8",
    );

    expect(migration).toContain("role_code='owner_group'");
    expect(migration).toContain("capability='audit:read'");
    expect(migration).toContain("role_code IN ('quality_control','tail_supervisor')");
    expect(migration).toContain("capability='supplier_profile:read'");
    expect(migration).not.toContain("capability='supplier_catalog:read';");
  });

  it("keeps the approved Acceptance expectations aligned with the closure", () => {
    const owner = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "owner");
    const tail = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "tail-supervisor");
    const qc = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "qc");

    expect(owner?.forbiddenCapabilities).toContain("audit:read");
    for (const entry of [tail, qc]) {
      expect(entry?.allowedModules).not.toContain("suppliers");
      expect(entry?.probes?.find((probe) => probe.id === "supplier-list")?.expectedStatus).toBe(403);
    }
  });
});
