import { describe, expect, it } from "vitest";

import { truncateDecimal } from "../../apps/api/src/rework/process-configuration-service.js";

describe("process configuration decimal truncation", () => {
  it("preserves valid decimal values before applying no-rounding precision rules", () => {
    expect(truncateDecimal(1.005, 3)).toBe(1.005);
    expect(truncateDecimal(1.15, 2)).toBe(1.15);
    expect(truncateDecimal(8.1269, 3)).toBe(8.126);
  });

  it("also truncates exponential numeric input without binary multiplication", () => {
    expect(truncateDecimal(1.2345e-3, 3)).toBe(0.001);
    expect(truncateDecimal(1.2345e3, 2)).toBe(1234.5);
  });
});
