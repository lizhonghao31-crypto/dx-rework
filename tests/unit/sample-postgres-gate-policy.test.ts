import { describe, expect, it } from "vitest";

import { classifyFullGatePaths } from "../../scripts/ci/full-gate-risk-map.mjs";

describe("sample PostgreSQL gate coverage", () => {
  it.each([
    "apps/api/src/samples/sample-analysis-service.ts",
    "packages/contracts/src/sample-analysis.ts",
    "tests/integration/sample-analysis-postgres.cases.ts",
    "tests/integration/sample-read-postgres.test.ts",
  ])("runs real PostgreSQL for %s", (path) => {
    const result = classifyFullGatePaths([path]);
    expect(result.dbRequired).toBe(true);
    expect(result.businessChainSensitive).toBe(true);
    if (path.startsWith("tests/integration/")) {
      expect(result.mappedPostgresTests).toEqual(["tests/integration/sample-read-postgres.test.ts"]);
    }
  });

  it.each([
    "apps/web/src/sample-operations.css",
    "docs/roadmap/ui-polish-20260908-v1.0.md",
  ])("does not escalate presentation-only %s", (path) => {
    const result = classifyFullGatePaths([path]);
    expect(result.dbRequired).toBe(false);
    expect(result.businessChainSensitive).toBe(false);
    expect(result.mappedPostgresTests).toEqual([]);
  });
});
