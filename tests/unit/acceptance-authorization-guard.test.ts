import { describe, expect, it, vi } from "vitest";

import {
  assertStandardAcceptanceAuthorization,
  preflightExistingAcceptanceIdentity,
} from "../../scripts/acceptance/authorization-guard.js";

describe("acceptance standard authorization guard", () => {
  it("allows a clean identity with only its expected role", () => {
    expect(() => assertStandardAcceptanceAuthorization({
      alias: "worker-a",
      expectedRole: "worker",
      activeRoles: ["worker"],
      unrevokedDelegationIds: [],
    })).not.toThrow();
  });

  it("allows a not-yet-assigned identity so the seeder can add its standard role", () => {
    expect(() => assertStandardAcceptanceAuthorization({
      alias: "worker-a",
      expectedRole: "worker",
      activeRoles: [],
      unrevokedDelegationIds: [],
    })).not.toThrow();
  });

  it("rejects stale extra roles instead of silently producing a privileged test identity", () => {
    expect(() => assertStandardAcceptanceAuthorization({
      alias: "worker-a",
      expectedRole: "worker",
      activeRoles: ["worker", "system_admin"],
      unrevokedDelegationIds: [],
    })).toThrow(/unexpected roles: system_admin/);
  });

  it("rejects every unrevoked delegation, including scoped or future grants", () => {
    expect(() => assertStandardAcceptanceAuthorization({
      alias: "worker-a",
      expectedRole: "worker",
      activeRoles: ["worker"],
      unrevokedDelegationIds: ["00000000-0000-4000-8000-000000000099"],
    })).toThrow(/unrevoked delegations/);
  });

  it("preflights an existing dirty identity using reads only and fails before any mutation", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).toMatch(/^SELECT|\n\s*SELECT/);
      if (sql.includes("identity_mappings")) return { rows: [{ user_id: "00000000-0000-4000-8000-000000000001" }] };
      if (sql.includes("user_role_assignments")) return { rows: [{ role_code: "worker" }, { role_code: "system_admin" }] };
      if (sql.includes("delegated_authorizations")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });

    await expect(preflightExistingAcceptanceIdentity(
      { query } as never,
      { corpId: "corp-acceptance", alias: "worker-a", expectedRole: "worker" },
    )).rejects.toThrow(/unexpected roles: system_admin/);
    expect(query).toHaveBeenCalledTimes(3);
    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it("returns null without authorization queries when the standard identity does not exist yet", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(preflightExistingAcceptanceIdentity(
      { query } as never,
      { corpId: "corp-acceptance", alias: "worker-a", expectedRole: "worker" },
    )).resolves.toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });
});
