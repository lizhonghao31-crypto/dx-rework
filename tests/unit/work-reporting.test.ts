import { splitAmount } from "../../apps/api/src/rework/work-reporting-service.js";
import { describe, expect, it } from "vitest";

describe("work reporting monetary snapshots", () => {
  it("allocates the four-decimal residual deterministically so member shares equal the group total", () => {
    const shares = splitAmount(0.1, 3);
    expect(shares).toEqual([0.0334, 0.0333, 0.0333]);
    expect(shares.reduce((total, share) => total + share, 0)).toBeCloseTo(0.1, 8);
  });
});
