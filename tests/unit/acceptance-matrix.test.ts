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
  it("covers every active standard seeded acceptance alias exactly once", () => {
    const aliases = ACCEPTANCE_ROLE_MATRIX.map((entry) => entry.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).toEqual([
      "root", "owner", "production-management", "ie", "tail-supervisor", "qc", "warehouse",
      "worker-a", "worker-b", "merchandiser", "finance-read", "finance-director", "factory-payables",
      "system-admin", "production-reporter", "sample-designer", "sample-admin", "sample-finance",
    ]);
    expect(aliases).not.toContain("sample-approver");
  });

  it("keeps finance-director sample access read-only and adds the confirmed production dashboard", () => {
    const finance = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "finance-director")!;
    expect(finance.requiredCapabilities).toEqual(expect.arrayContaining([
      "supplier_profile:read", "sample:view_basic", "sample:view_finance", "sample:view_audit",
    ]));
    expect(finance.forbiddenCapabilities).toEqual(expect.arrayContaining([
      "access:admin", "sample:create", "sample:batch_create", "sample:update_basic", "sample:correct_finance",
      "sample:dispose_request", "sample:dispose_approve", "sample:archive",
    ]));
    expect(finance.allowedModules).toContain("production");
    expect(finance.probes?.find((probe) => probe.id === "production-dashboard")?.expectedStatus).toBe(200);
    for (const key of [
      "cap:sample:view_basic:allow",
      "cap:sample:view_finance:allow",
      "cap:sample:view_audit:allow",
      "cap:sample:create:deny",
      "cap:sample:archive:deny",
      "module:samples:allow",
      "http:sample-list",
    ]) {
      expect(finance.ruleRefs?.[key]).toEqual({
        ruleId: "PERM-SAMPLE-FINANCE-DIRECTOR-001",
        status: "approved",
      });
    }
  });

  it("marks every confirmed supplier-center boundary approved instead of pending", () => {
    const expected = new Map([
      ["production-management", "PERM-SUPPLIER-PM-CENTER-001"],
      ["ie", "PERM-SUPPLIER-IE-CENTER-001"],
      ["tail-supervisor", "PERM-SUPPLIER-TAIL-001"],
      ["qc", "PERM-SUPPLIER-QC-001"],
      ["warehouse", "PERM-SUPPLIER-WAREHOUSE-001"],
      ["worker-a", "PERM-SUPPLIER-WORKER-001"],
      ["worker-b", "PERM-SUPPLIER-WORKER-001"],
      ["merchandiser", "PERM-SUPPLIER-MERCH-CENTER-001"],
      ["finance-director", "PERM-SUPPLIER-FINANCE-CENTER-001"],
      ["factory-payables", "PERM-SUPPLIER-FACTORY-PAYABLES-CENTER-001"],
    ]);
    for (const [alias, ruleId] of expected) {
      const entry = ACCEPTANCE_ROLE_MATRIX.find((candidate) => candidate.alias === alias)!;
      expect(entry.ruleRefs?.["http:supplier-list"]).toEqual({ ruleId, status: "approved" });
    }
  });

  it("locks personnel administration to Root at acceptance level", () => {
    const root = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "root")!;
    const owner = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "owner")!;
    expect(root.probes?.find((probe) => probe.id === "access-roles")?.expectedStatus).toBe(200);
    expect(owner.probes?.find((probe) => probe.id === "access-roles")?.expectedStatus).toBe(403);
    expect(owner.forbiddenCapabilities).toContain("access:admin");
  });

  it("detects a session bound to the wrong UAT identity as an infrastructure failure", () => {
    const worker = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "worker-a")!;
    const checks = evaluateAcceptanceSnapshot(
      worker,
      { alias: "worker-a", userId: "uat-worker-a-id", roleCodes: ["worker"], capabilities: ["work:report"] },
      user("worker", ["work:report"], false, "uat-worker-b-id"),
    );
    const session = checks.find((entry) => entry.key.endsWith(":session-user"))!;
    expect(session.verdict).toBe("fail");
    expect(session.ruleStatus).toBe("infrastructure");
    expect(session.ruleId).toBe("ACCEPTANCE-INFRASTRUCTURE");
  });

  it("lets an approved supplier boundary fail when runtime access diverges", () => {
    const tail = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "tail-supervisor")!;
    const supplierProbe = tail.probes?.find((probe) => probe.id === "supplier-list");
    if (!supplierProbe) throw new Error("tail-supervisor supplier-list probe is missing");
    const check = evaluateHttpProbe(tail, supplierProbe, 200);
    expect(check.expected).toBe("HTTP 403");
    expect(check.actual).toBe("HTTP 200");
    expect(check.verdict).toBe("fail");
    expect(check.ruleId).toBe("PERM-SUPPLIER-TAIL-001");
    expect(check.ruleStatus).toBe("approved");
  });

  it("lets an approved Golden Source rule fail when runtime behavior diverges", () => {
    const root = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "root")!;
    const accessProbe = root.probes?.find((probe) => probe.id === "access-roles");
    if (!accessProbe) throw new Error("root access-roles probe is missing");
    const check = evaluateHttpProbe(root, accessProbe, 403);
    expect(check.verdict).toBe("fail");
    expect(check.ruleId).toBe("PERM-PLATFORM-ROOT-001");
    expect(check.ruleStatus).toBe("approved");
  });

  it("quarantines an unmapped business check instead of treating current implementation as the oracle", () => {
    const check = evaluateHttpProbe("worker-a", {
      id: "unmapped", label: "尚未绑定规则的业务探针", path: "example", expectedStatus: 403,
    }, 200);
    expect(check.verdict).toBe("pending");
    expect(check.ruleStatus).toBe("unmapped");
    expect(check.ruleId).toBe("PERM-ACCEPTANCE-UNMAPPED-001");
  });

  it("keeps infrastructure HTTP checks strict without a business Golden Source rule", () => {
    const check = evaluateHttpProbe("worker-a", {
      id: "switch", label: "切换真实业务 Session", path: "acceptance/control/switch", expectedStatus: 200,
      infrastructure: true,
    }, 500);
    expect(check.verdict).toBe("fail");
    expect(check.ruleStatus).toBe("infrastructure");
  });
});
