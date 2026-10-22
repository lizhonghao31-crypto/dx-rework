import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

import { assertAppliedMigrationHistory } from "../../scripts/migration-lib.mjs";

const expected = [
  { version: "0001_foundation", checksum: "1".repeat(64) },
  { version: "0002_feature", checksum: "2".repeat(64) },
];

describe("applied migration history", () => {
  it("accepts an exact prefix before pending Head migrations are applied", () => {
    expect(() => assertAppliedMigrationHistory(expected.slice(0, 1), expected)).not.toThrow();
  });

  it("rejects checksum drift in an applied migration", () => {
    expect(() =>
      assertAppliedMigrationHistory(
        [{ version: "0001_foundation", checksum: "0".repeat(64) }],
        expected,
      ),
    ).toThrow("Migration checksum drift detected: 0001_foundation");
  });

  it("rejects an applied migration removed from the Head manifest", () => {
    expect(() =>
      assertAppliedMigrationHistory(
        [...expected, { version: "0003_removed", checksum: "3".repeat(64) }],
        expected,
      ),
    ).toThrow("Applied migration is absent from Head manifest: 0003_removed");
  });

  it("rejects a gap or reorder in applied history", () => {
    expect(() => assertAppliedMigrationHistory(expected.slice(1), expected)).toThrow(
      "Applied migration history diverged at position 1",
    );
  });

  it("accepts both frozen source histories and rejects a bridge receipt missing either main prerequisite", () => {
    const target = JSON.parse(readFileSync("apps/api/src/platform/migration-manifest.json", "utf8")).migrations as typeof expected;
    for (const name of ["main-ecaf6999", "release-4c731753"]) {
      const history = JSON.parse(readFileSync(`tests/fixtures/migration-histories/${name}.json`, "utf8")).migrations;
      expect(() => assertAppliedMigrationHistory(history, target)).not.toThrow();
    }
    for (const version of ["0228_sourcing_contract_return_cycles", "0229_sourcing_price_reapplications"]) {
      expect(() => assertAppliedMigrationHistory(target.filter(row => row.version !== version), target)).toThrow();
    }
    expect(() => assertAppliedMigrationHistory(target, target)).not.toThrow();
  });
});
