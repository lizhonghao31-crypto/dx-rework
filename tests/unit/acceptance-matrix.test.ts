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
  it("covers the active Golden Source roles exactly once and excludes retired roles", () => {
    const aliases = ACCEPTANCE_ROLE_MATRIX.map((entry) => entry.alias);
    expect(new Set(aliases).size).toBe(aliases.length);
    expect(aliases).toEqual([
      "root", "owner", "production-management", "ie", "tail-supervisor", "qc", "warehouse",
      "worker-a", "worker-b", "merchandiser", "embroidery-washing-merchandiser", "finance-read",
      "finance-director", "factory-payables", "embroidery-washing-payables", "fabric-payables",
      "wage-month-close-accountant", "system-admin", "production-reporter", "sample-designer",
      "sample-admin", "sample-finance",
    ]);
    expect(aliases).not.toContain("sample-approver");
    expect(ACCEPTANCE_ROLE_MATRIX.some((entry) => entry.expectedRole === "tail_inspector")).toBe(false);
    expect(ACCEPTANCE_ROLE_MATRIX.some((entry) => entry.expectedRole === "administrative_clerk")).toBe(false);
  });

  it("explicitly binds every current business check to an approved rule", () => {
    for (const entry of ACCEPTANCE_ROLE_MATRIX) {
      expect(Object.values(entry.ruleRefs ?? {}).every((rule) => rule.status === "approved")).toBe(true);

      const identityUserId = `uat-${entry.alias}-id`;
      const checks = evaluateAcceptanceSnapshot(
        entry,
        {
          alias: entry.alias,
          userId: identityUserId,
          roleCodes: [entry.expectedRole],
          capabilities: entry.requiredCapabilities ?? [],
        },
        user(entry.expectedRole, entry.requiredCapabilities ?? [], entry.expectedRoot === true, identityUserId),
      );
      for (const check of checks.filter((candidate) => candidate.ruleStatus !== "infrastructure")) {
        expect(check.ruleStatus, `${entry.alias}:${check.key}`).toBe("approved");
      }
      for (const probe of entry.probes ?? []) {
        const check = evaluateHttpProbe(entry, probe, probe.expectedStatus);
        if (!probe.infrastructure) expect(check.ruleStatus, `${entry.alias}:http:${probe.id}`).toBe("approved");
      }
    }
  });

  it("enforces Root-only personnel administration for owner and system-admin", () => {
    const owner = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "owner")!;
    const systemAdmin = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "system-admin")!;
    for (const entry of [owner, systemAdmin]) {
      const accessProbe = entry.probes?.find((probe) => probe.id === "access-roles");
      expect(accessProbe?.expectedStatus).toBe(403);
      expect(entry.ruleRefs?.["http:access-roles"]).toEqual({
        ruleId: "PERM-PLATFORM-ACCESS-ADMIN-001",
        status: "approved",
      });
    }
  });

  it("keeps finance-director sample access read-only and production dashboard read-only", () => {
    const finance = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "finance-director")!;
    expect(finance.requiredCapabilities).toEqual(expect.arrayContaining([
      "sample:view_basic", "sample:view_finance", "sample:view_audit",
    ]));
    expect(finance.forbiddenCapabilities).toEqual(expect.arrayContaining([
      "production-reporting", "sample:create", "sample:batch_create", "sample:update_basic",
      "sample:correct_finance", "sample:dispose_request", "sample:dispose_approve", "sample:archive",
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

  it("binds every confirmed supplier-center boundary to an approved rule", () => {
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

  it("lets a confirmed supplier rule fail instead of quarantining it as pending", () => {
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

  it("lets an approved Root rule fail when runtime behavior diverges", () => {
    const root = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "root")!;
    const accessProbe = root.probes?.find((probe) => probe.id === "access-roles");
    if (!accessProbe) throw new Error("root access-roles probe is missing");
    const check = evaluateHttpProbe(root, accessProbe, 403);
    expect(check.verdict).toBe("fail");
    expect(check.ruleId).toBe("PERM-PLATFORM-ROOT-001");
    expect(check.ruleStatus).toBe("approved");
  });

  it("quarantines a future capability added to an existing role unless that exact check has a ruleRef", () => {
    const owner = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "owner")!;
    const futureExpectation = {
      ...owner,
      requiredCapabilities: [...(owner.requiredCapabilities ?? []), "future:unapproved"],
    };
    const identityUserId = "uat-owner-id";
    const checks = evaluateAcceptanceSnapshot(
      futureExpectation,
      { alias: "owner", userId: identityUserId, roleCodes: ["owner_group"], capabilities: futureExpectation.requiredCapabilities },
      user("owner_group", futureExpectation.requiredCapabilities, false, identityUserId),
    );
    const future = checks.find((entry) => entry.key.endsWith(":cap:future:unapproved:allow"))!;
    expect(future.verdict).toBe("pending");
    expect(future.ruleStatus).toBe("unmapped");
    expect(future.ruleId).toBe("PERM-ACCEPTANCE-UNMAPPED-001");
  });

  it("quarantines only a genuinely unmapped future business check", () => {
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
