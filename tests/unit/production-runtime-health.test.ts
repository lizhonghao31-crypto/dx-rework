import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("trusted production runtime health guard", () => {
  it("checks both active slots and fails closed without touching a live service", () => {
    const result = spawnSync("python3", ["tests/unit/production-runtime-health.test.py"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ran 13 tests");
    expect(result.stderr).toContain("OK");
    const deployEntries = readdirSync("scripts/deploy").filter((name) => !name.startsWith("."));
    expect(deployEntries).not.toContain("__pycache__");
    const destination = mkdtempSync(join(tmpdir(), "dx-deploy-copy-regression-"));
    try {
      // Reproduce package-release.sh's non-recursive scripts/deploy/* copy.
      const copied = spawnSync("cp", [...deployEntries.map((name) => join("scripts/deploy", name)), destination], { encoding: "utf8" });
      expect(copied.status, copied.stderr).toBe(0);
    } finally {
      rmSync(destination, { recursive: true, force: true });
    }
  });
});
