import { readFile } from "node:fs/promises";

import {
  CreateBusinessPersonSchema,
  CreateDelegationSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("access and master-data contracts", () => {
  it("keeps temporary people outside login identities", () => {
    expect(CreateBusinessPersonSchema.safeParse({
      personType: "temporary",
      appUserId: "00000000-0000-4000-8000-000000000001",
      displayName: "临时工",
    }).success).toBe(false);
    expect(CreateBusinessPersonSchema.safeParse({
      personType: "internal",
      displayName: "员工",
    }).success).toBe(false);
  });

  it("requires exact delegation scope and a forward time range", () => {
    const base = {
      grantorUserId: "00000000-0000-4000-8000-000000000001",
      granteeUserId: "00000000-0000-4000-8000-000000000002",
      capability: "finance:read",
      validFrom: "2026-08-01T00:00:00.000Z",
      validUntil: "2026-08-02T00:00:00.000Z",
      reason: "临时协助",
    };
    expect(CreateDelegationSchema.safeParse({ ...base, scopeType: "global" }).success).toBe(true);
    expect(CreateDelegationSchema.safeParse({ ...base, scopeType: "global", scopeId: "order-1" }).success).toBe(false);
    expect(CreateDelegationSchema.safeParse({ ...base, scopeType: "rework_order" }).success).toBe(false);
  });

  it("codifies the approved role separation in the immutable migration", async () => {
    const migration = await readFile(
      new URL("../../apps/api/migrations/0005_access_master_data.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("normalized_alias text NOT NULL UNIQUE");
    expect(migration).toContain("CHECK ((person_type = 'internal') = (app_user_id IS NOT NULL))");
    expect(migration).toContain("('owner_group', 'own_factory:approve')");
    expect(migration).toContain("('owner_group', 'access:admin')");
    expect(migration).not.toMatch(/\('production_management', 'own_factory:approve'\)/);
    expect(migration).not.toMatch(/\('system_admin', 'own_factory:approve'\)/);
    expect(migration).not.toMatch(/INSERT INTO business_people/i);
  });
});
