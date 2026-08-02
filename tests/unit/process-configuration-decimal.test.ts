import { describe, expect, it } from "vitest";

import {
  customPromotionLockKeys,
  truncateDecimal,
} from "../../apps/api/src/rework/process-configuration-service.js";

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

describe("process configuration promotion lock order", () => {
  it("deduplicates and sorts every custom-process key before PostgreSQL locks are acquired", () => {
    expect(customPromotionLockKeys([
      { source: "custom", processName: "zeta-rework", pricingUnit: "hour" },
      { source: "custom", processName: "alpha-rework", pricingUnit: "piece" },
      { source: "custom", processName: "ALPHA-REWORK", pricingUnit: "piece" },
      { source: "catalog", processName: "catalog-only", pricingUnit: "piece" },
    ])).toEqual([
      "dx_rework:custom-process:alpha-rework:piece",
      "dx_rework:custom-process:zeta-rework:hour",
    ]);
  });
});
