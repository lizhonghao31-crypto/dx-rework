import { describe, expect, it } from "vitest";

import {
  databaseNameFromConnectionUrl,
  isAcceptanceDatabaseName,
} from "../../scripts/acceptance/database-guard.js";

describe("acceptance database guard", () => {
  it.each([
    "acceptance",
    "uat",
    "test",
    "dx_rework_acceptance",
    "dx-rework-uat",
    "dx_test_ci",
    "uat_dx_rework",
  ])("accepts explicitly delimited acceptance database %s", (name) => {
    expect(isAcceptanceDatabaseName(name)).toBe(true);
  });

  it.each([
    "dx_rework_latest",
    "contest",
    "latest",
    "production",
    "dxreworkuat",
    "attestation",
    "",
  ])("rejects ambiguous or non-acceptance database %s", (name) => {
    expect(isAcceptanceDatabaseName(name)).toBe(false);
  });

  it("extracts only one explicit database path component from the connection URL", () => {
    expect(databaseNameFromConnectionUrl("postgresql://user:pass@127.0.0.1:5432/dx_rework_test"))
      .toBe("dx_rework_test");
    expect(databaseNameFromConnectionUrl("postgresql://user:pass@127.0.0.1:5432/dx%5Frework%5Fuat"))
      .toBe("dx_rework_uat");
    expect(databaseNameFromConnectionUrl("postgresql://user:pass@127.0.0.1:5432/"))
      .toBe("");
  });
});
