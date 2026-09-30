import { describe, expect, it } from "vitest";

import { classifyFullGatePaths } from "../../scripts/ci/full-gate-risk-map.mjs";

describe("Full Gate sensitive path mapping", () => {
  it.each([
    ["apps/api/src/pattern-room/order-service.ts", "pattern-room", []],
    ["apps/api/src/access/service.ts", "access", ["tests/integration/access-postgres.test.ts"]],
    ["apps/api/src/auth/service.ts", "access", ["tests/integration/employee-access-lifecycle-postgres.test.ts"]],
    ["apps/api/src/wages/wage-service.ts", "wages", ["tests/integration/finance-wage-access-postgres.test.ts"]],
    ["apps/api/src/access/supplier-onboarding-service.ts", "suppliers", ["tests/integration/supplier-onboarding-postgres.test.ts"]],
    ["apps/api/src/tools/attachments.ts", "tools", ["tests/integration/public-tools-postgres.test.ts"]],
    ["apps/api/src/receiving/receiving-service.ts", "receiving", ["tests/integration/receiving-postgres.test.ts"]],
  ])("maps %s to %s and real PostgreSQL coverage", (path, domain, expectedTests) => {
    const result = classifyFullGatePaths([path]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(true);
    expect(result.domains).toContain(domain);
    for (const test of expectedTests) expect(result.mappedPostgresTests).toContain(test);
  });

  it("fails closed for an unknown backend or shared-contract path", () => {
    for (const path of [
      "apps/api/src/new-domain/unclassified-service.ts",
      "packages/contracts/src/new-sensitive-contract.ts",
    ]) {
      const result = classifyFullGatePaths([path]);
      expect(result.highRisk).toBe(true);
      expect(result.dbRequired).toBe(true);
      expect(result.businessChainSensitive).toBe(true);
      expect(result.domains).toContain("backend");
    }
  });

  it("keeps isolated web, CSS and documentation changes out of DB escalation", () => {
    for (const path of [
      "apps/web/src/example-page.tsx",
      "apps/web/src/example.css",
      "docs/governance/example.md",
    ]) {
      const result = classifyFullGatePaths([path]);
      expect(result.highRisk).toBe(false);
      expect(result.dbRequired).toBe(false);
      expect(result.mappedPostgresTests).toEqual([]);
    }
  });

  it("maps access/auth through a discoverable PostgreSQL wrapper", () => {
    const result = classifyFullGatePaths(["apps/api/src/access/service.ts"]);
    expect(result.mappedPostgresTests).toContain("tests/integration/full-business-chain-postgres.test.ts");
    expect(result.mappedPostgresTests).not.toContain("tests/integration/member-module-policy-postgres.cases.ts");
  });

  it("does not schedule a deleted PostgreSQL test path while still escalating the diff", () => {
    const deleted = classifyFullGatePaths(["tests/integration/removed-postgres.test.ts"]);
    expect(deleted.businessChainSensitive).toBe(true);
    expect(deleted.dbRequired).toBe(true);
    expect(deleted.domains).toContain("postgres-test");
    expect(deleted.mappedPostgresTests).not.toContain("tests/integration/removed-postgres.test.ts");
  });

  it("maps migration, deployment and changed PostgreSQL tests explicitly", () => {
    const migration = classifyFullGatePaths(["apps/api/migrations/9999_test.sql"]);
    expect(migration.migrationSensitive).toBe(true);
    expect(migration.dbRequired).toBe(true);

    const deployment = classifyFullGatePaths([".github/workflows/full-gate.yml"]);
    expect(deployment.deploymentSensitive).toBe(true);
    expect(deployment.dbRequired).toBe(true);

    const changedTest = "tests/integration/supplier-onboarding-postgres.test.ts";
    const test = classifyFullGatePaths([changedTest]);
    expect(test.mappedPostgresTests).toContain(changedTest);
    expect(test.dbRequired).toBe(true);
  });
});
