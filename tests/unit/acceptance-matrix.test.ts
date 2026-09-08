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
  id = `user-${role}`,
) => ({ id, displayName: role, businessRoles: [role], capabilities, isRoot });

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

  it("keeps finance-director sample access read-only as an approved target instead of deriving it from current RBAC", () => {
    const finance = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "finance-director")!;
    expect(finance.requiredCapabilities).toEqual(expect.arrayContaining([
      "sample:view_basic", "sample:view_finance", "sample:view_audit",
    ]));
    expect(finance.forbiddenCapabilities).toEqual(expect.arrayContaining([
      "sample:create", "sample:batch_create", "sample:update_basic", "sample:correct_finance",
      "sample:dispose_request", "sample:dispose_approve", "sample:archive",
    ]));
    expect(finance.allowedModules).toContain("samples");
    expect(finance.probes?.find((probe) => probe.id === "sample-list")?.expectedStatus).toBe(200);
  });

  it("defines a complete finance-read module boundary and representative backend denials", () => {
    const finance = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "finance-read")!;
    expect(finance.allowedModules).toEqual(["rework"]);
    expect(finance.forbiddenModules).toEqual(["sourcing", "suppliers", "production", "samples"]);
    expect(finance.probes?.map((probe) => [probe.id, probe.expectedStatus])).toEqual([
      ["access-roles", 403], ["sourcing-list", 403], ["supplier-list", 403], ["sample-list", 403],
    ]);
  });

  it("detects a session bound to the wrong UAT identity even when role and capability profile match", () => {
    const worker = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "worker-a")!;
    const checks = evaluateAcceptanceSnapshot(
      worker,
      { alias: "worker-a", userId: "uat-worker-a-id", roleCodes: ["worker"], capabilities: ["work:report"] },
      user("worker", ["work:report"], false, "uat-worker-b-id"),
    );
    expect(checks.find((entry) => entry.key.endsWith(":session-user"))?.verdict).toBe("fail");
  });

  it("reports role, root and capability drift without rewriting the approved expectation", () => {
    const worker = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "worker-a")!;
    const checks = evaluateAcceptanceSnapshot(
      worker,
      { alias: "worker-a", userId: "user-worker", roleCodes: ["worker"], capabilities: ["work:report"] },
      user("worker", ["work:report", "access:admin"], true),
    );
    expect(checks.find((entry) => entry.key.endsWith(":session-user"))?.verdict).toBe("pass");
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
