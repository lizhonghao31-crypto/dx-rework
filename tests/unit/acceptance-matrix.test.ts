import { describe, expect, it } from "vitest";

import {
  ACCEPTANCE_ROLE_MATRIX,
  evaluateAcceptanceSnapshot,
  evaluateHttpProbe,
} from "../../apps/web/src/acceptance-matrix.js";

const user = (
  role: string,
  capabilities: readonly string[],
  isRoot = false,
) => ({ id: `user-${role}`, displayName: role, businessRoles: [role], capabilities, isRoot });

describe("acceptance authorization matrix", () => {
  it("covers every standard seeded acceptance alias exactly once", () => {
    const aliases = ACCEPTANCE_ROLE_MATRIX.map((entry) => entry.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).toEqual([
      "root", "owner", "production-management", "ie", "tail-supervisor", "qc", "warehouse",
      "worker-a", "worker-b", "merchandiser", "finance-read", "finance-director", "factory-payables",
      "system-admin", "production-reporter", "sample-designer", "sample-admin", "sample-finance", "sample-approver",
    ]);
  });

  it("keeps finance-director sample read access as an approved target instead of deriving it from current RBAC", () => {
    const finance = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "finance-director")!;
    expect(finance.requiredCapabilities).toContain("sample:view_basic");
    expect(finance.allowedModules).toContain("samples");
    expect(finance.probes?.find((probe) => probe.id === "sample-list")?.expectedStatus).toBe(200);
  });

  it("reports role, root and capability drift without rewriting the approved expectation", () => {
    const worker = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "worker-a")!;
    const checks = evaluateAcceptanceSnapshot(
      worker,
      { alias: "worker-a", roleCodes: ["worker"], capabilities: ["work:report"] },
      user("worker", ["work:report", "access:admin"], true),
    );
    expect(checks.find((entry) => entry.key.endsWith(":root"))?.verdict).toBe("fail");
    expect(checks.find((entry) => entry.key.includes("access:admin"))?.verdict).toBe("fail");
  });

  it("compares safe HTTP probes against explicit expected statuses", () => {
    const check = evaluateHttpProbe("worker-a", {
      id: "access-roles", label: "人员权限角色表", path: "access/roles", expectedStatus: 403,
    }, 200);
    expect(check.verdict).toBe("fail");
    expect(check.expected).toBe("HTTP 403");
    expect(check.actual).toBe("HTTP 200");
  });
});
