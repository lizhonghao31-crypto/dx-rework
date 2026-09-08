import { describe, expect, it, vi } from "vitest";

import {
  assertStandardAcceptanceAuthorization,
  preflightAcceptanceRootState,
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

  it("recognizes a completely fresh Root state without writing anything", async () => {
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
      return { rows: [] };
    });
    await expect(preflightAcceptanceRootState(
      { query } as never,
      "corp-acceptance",
    )).resolves.toEqual({ mode: "fresh" });
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("accepts an existing Root only when policy, bootstrap, identity and owner role agree", async () => {
    const rootId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
      if (sql.includes("access_security_policy")) return { rows: [{ ok: 1 }] };
      if (sql.includes("identity_mappings")) return { rows: [{ user_id: rootId }] };
      if (sql.includes("owner_bootstrap_consumptions")) {
        return { rows: [{ user_id: rootId, provider_user_id: "uat-root", corp_id: "corp-acceptance" }] };
      }
      if (sql.includes("user_role_assignments")) return { rows: [{ ok: 1 }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(preflightAcceptanceRootState(
      { query } as never,
      "corp-acceptance",
    )).resolves.toEqual({ mode: "existing", userId: rootId });
    expect(query).toHaveBeenCalledTimes(4);
  });

  it("rejects a policy-bound Root missing owner_group before any seed mutation", async () => {
    const rootId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
      if (sql.includes("access_security_policy")) return { rows: [{ ok: 1 }] };
      if (sql.includes("identity_mappings")) return { rows: [{ user_id: rootId }] };
      if (sql.includes("owner_bootstrap_consumptions")) {
        return { rows: [{ user_id: rootId, provider_user_id: "uat-root", corp_id: "corp-acceptance" }] };
      }
      if (sql.includes("user_role_assignments")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(preflightAcceptanceRootState(
      { query } as never,
      "corp-acceptance",
    )).rejects.toThrow(/Root owner role is missing/);
    for (const [sql] of query.mock.calls) expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
  });

  it("rejects a bootstrap pointing at another synthetic identity", async () => {
    const rootId = "00000000-0000-4000-8000-000000000001";
    const query = vi.fn(async (sql: string) => {
      expect(sql).not.toMatch(/INSERT|UPDATE|DELETE/i);
      if (sql.includes("access_security_policy")) return { rows: [{ ok: 1 }] };
      if (sql.includes("identity_mappings")) return { rows: [{ user_id: rootId }] };
      if (sql.includes("owner_bootstrap_consumptions")) {
        return {
          rows: [{
            user_id: "00000000-0000-4000-8000-000000000099",
            provider_user_id: "uat-worker-a",
            corp_id: "corp-acceptance",
          }],
        };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(preflightAcceptanceRootState(
      { query } as never,
      "corp-acceptance",
    )).rejects.toThrow(/Root bootstrap/);
  });
});
