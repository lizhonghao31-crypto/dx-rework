import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing factory-change role metadata migration", () => {
  it("adds role-aware immutable metadata without changing the live workflow", async () => {
    const migration = await readFile(
      "apps/api/migrations/0127_sourcing_factory_change_role_metadata.sql",
      "utf8",
    );

    expect(migration).toContain("ADD COLUMN initiator_role");
    expect(migration).toContain("'order_merchandiser'");
    expect(migration).toContain("'production_management'");
    expect(migration).toContain("'owner_group'");
    expect(migration).toContain("ADD COLUMN requires_owner_approval");
    expect(migration).toContain("ADD COLUMN decision_role");
    expect(migration).toContain("set_sourcing_factory_change_price_policy");
    expect(migration).toContain("NEW.proposed_unit_price>baseline_unit_price");

    const disableGuard = migration.indexOf(
      "DISABLE TRIGGER sourcing_factory_change_requests_no_update",
    );
    const backfill = migration.indexOf("UPDATE sourcing_factory_change_requests request_row");
    const enableGuard = migration.indexOf(
      "ENABLE TRIGGER sourcing_factory_change_requests_no_update",
    );
    expect(disableGuard).toBeGreaterThan(-1);
    expect(backfill).toBeGreaterThan(disableGuard);
    expect(enableGuard).toBeGreaterThan(backfill);

    expect(migration).not.toContain("guard_sourcing_transition_insert");
    expect(migration).not.toContain("guard_sourcing_reconciliation");
    expect(migration).not.toContain("DROP CONSTRAINT");
    expect(migration).not.toContain("sourcing_factory_change_decisions_request_role_key");
  });
});
