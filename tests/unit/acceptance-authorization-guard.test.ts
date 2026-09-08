import { describe, expect, it } from "vitest";

import { assertStandardAcceptanceAuthorization } from "../../scripts/acceptance/authorization-guard.js";

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
});
