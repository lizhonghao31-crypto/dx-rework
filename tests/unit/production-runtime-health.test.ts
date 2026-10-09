import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("trusted production runtime health guard", () => {
  it("checks both active slots and fails closed without touching a live service", () => {
    const result = spawnSync("python3", ["tests/unit/production-runtime-health.test.py"], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("Ran 13 tests");
    expect(result.stderr).toContain("OK");
  });
});
