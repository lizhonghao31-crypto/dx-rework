import { readFileSync } from "node:fs";
import { basename } from "node:path";

import { describe, expect, it } from "vitest";

import { assertMappedPostgresTests, classifyFullGatePaths, POSTGRES_CASE_SUITES } from "../../scripts/ci/full-gate-risk-map.mjs";

it("requires Full and complete deployment checks for the lane executor alone", () => {
  const result = classifyFullGatePaths(["scripts/ci/full-gate-lanes.mjs"]);
  expect(result.highRisk).toBe(true);
  expect(result.dbRequired).toBe(true);
  expect(result.deploymentSensitive).toBe(true);
  expect(result).toEqual(classifyFullGatePaths(["scripts/ci/ci-gate-runtime.mjs"]));
  expect(result.maintenanceSensitive).toBe(true);
  expect(result.activationSensitive).toBe(true);
  expect(result.transferSensitive).toBe(true);
});

describe("Full Gate sensitive path mapping", () => {
  it("maps changed bulk requirements and their shared clock fixture to all actual consumer suites",()=>{
    for(const path of ['tests/helpers/business-anchor-fixture.ts','tests/helpers/bulk-preparation-fixture.ts','tests/helpers/bulk-preshrink-correction-fixture.ts','apps/api/src/production-platform/bulk-preshrink-correction-service.ts','apps/api/src/production-platform/bulk-sla-evidence.ts']){
      const result=classifyFullGatePaths([path]);expect(result.businessChainSensitive).toBe(true);
      for(const suite of ['business-anchors-clock','production-readiness','sourcing-pr03','sourcing-digital-flow','bulk-preshrink-correction'])expect(result.mappedPostgresTests).toContain(`tests/integration/${suite}-postgres.test.ts`);
      expect(()=>assertMappedPostgresTests(result.mappedPostgresTests)).not.toThrow();
    }
  });
  it("requires real PG13 Journey reads for query, route, contract and regression changes",()=>{
    for(const path of ["apps/api/src/production-platform/journey-log.ts","apps/api/src/production-platform/journey-query.ts","apps/api/src/production-platform/identity-routes.ts","packages/contracts/src/digital-production-journey.ts","tests/integration/digital-journey-postgres.test.ts","scripts/ci/journey-pg13-regression.mjs"]){
      const result=classifyFullGatePaths([path]);expect(result.journeyPg13Compat).toBe(true);expect(result.dbRequired).toBe(true);expect(result.mappedPostgresTests).toContain("tests/integration/digital-journey-postgres.test.ts");
    }
    for(const path of ["apps/web/src/cockpit-home.tsx","apps/api/src/receiving/receiving-service.ts","docs/requirements/cockpit-display-v1.0.md"])expect(classifyFullGatePaths([path]).journeyPg13Compat).toBe(false);
  });
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

  it.each(Object.entries(POSTGRES_CASE_SUITES))("maps imported module %s to runnable suite %s", (module, suite) => {
    const result = classifyFullGatePaths([module]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(true);
    expect(result.mappedPostgresTests).toEqual([suite]);
    expect(readFileSync(suite, "utf8")).toContain(basename(module).replace(/\.ts$/, ".js"));
    expect(() => assertMappedPostgresTests(result.mappedPostgresTests)).not.toThrow();
  });

  it("deduplicates a case module and its suite and rejects non-runnable entries", () => {
    const module = "tests/integration/receiving-analysis-postgres.cases.ts";
    const suite = "tests/integration/receiving-postgres.test.ts";
    expect(classifyFullGatePaths([module, suite]).mappedPostgresTests).toEqual([suite]);
    expect(() => assertMappedPostgresTests([module])).toThrow("not a runnable test suite");
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

  it("runs receiving analysis cases through the real receiving suite", () => {
    const result = classifyFullGatePaths(["tests/integration/receiving-analysis-postgres.cases.ts"]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(true);
    expect(result.mappedPostgresTests).toEqual(["tests/integration/receiving-postgres.test.ts"]);
  });

  it("maps migration, deployment and changed PostgreSQL tests explicitly", () => {
    const migration = classifyFullGatePaths(["apps/api/migrations/9999_test.sql"]);
    expect(migration.migrationSensitive).toBe(true);
    expect(migration.dbRequired).toBe(true);
    expect(migration.mappedPostgresTests).toContain("tests/integration/migration-compatibility-postgres.test.ts");

    const deployment = classifyFullGatePaths([".github/workflows/full-gate.yml"]);
    expect(deployment.deploymentSensitive).toBe(true);
    expect(deployment.dbRequired).toBe(true);
    expect(classifyFullGatePaths(["scripts/dx-acceptance.sh"]).deploymentSensitive).toBe(true);
    expect(classifyFullGatePaths(["scripts/ci/acceptance-maintenance-drill.mjs"]).deploymentSensitive).toBe(true);
    for(const path of ["scripts/ci/ci-gate-runtime.mjs","scripts/ci/pr-gate-protocol.mjs","scripts/ci/pr-gate-controller.mjs","scripts/ci/verify-actions-policy.mjs","scripts/check-main-release-compat.mjs","scripts/ci/main-release-history-drill.mjs","docs/operations/g1-acceptance-compat-update.sh"])expect(classifyFullGatePaths([path]).deploymentSensitive).toBe(true);
    expect(deployment.mappedPostgresTests).toContain("tests/integration/migration-compatibility-postgres.test.ts");
    for (const path of ["scripts/migration-lib.mjs", "scripts/migration-history-policy.mjs", "scripts/migration-branches.json", "scripts/migration-main-extensions.json", "scripts/check-migration-export.mjs"]) {
      const result = classifyFullGatePaths([path]);
      expect(result.migrationSensitive).toBe(true);
      expect(result.highRisk).toBe(true);
      expect(result.dbRequired).toBe(true);
      expect(result.mappedPostgresTests).toContain("tests/integration/migration-compatibility-postgres.test.ts");
    }

    const changedTest = "tests/integration/supplier-onboarding-postgres.test.ts";
    const test = classifyFullGatePaths([changedTest]);
    expect(test.mappedPostgresTests).toContain(changedTest);
    expect(test.dbRequired).toBe(true);
  });
});
