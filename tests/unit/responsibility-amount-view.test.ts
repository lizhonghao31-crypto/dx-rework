import type { ResponsibilityDeterminationResponse } from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

import { normalizeResponsibilityAmountView } from "../../apps/api/src/rework/responsibility-determination-application-service.js";

const itemId = "11111111-1111-4111-8111-111111111111";
const determinationId = "22222222-2222-4222-8222-222222222222";
const orderId = "33333333-3333-4333-8333-333333333333";

const view: ResponsibilityDeterminationResponse = {
  reworkOrderId: orderId,
  reworkStatus: "pending_responsibility_determination",
  orderVersion: 7,
  handlerUserId: null,
  canDetermine: true,
  canTakeover: false,
  canConfirmHighMultiplier: false,
  sourceProcesses: [{
    configurationItemId: itemId,
    processName: "返工工序",
    pricingUnit: "piece",
    baseAmount: "110.00000000",
  }],
  determination: {
    determinationId,
    version: 1,
    stage: "draft",
    reason: null,
    calculationTotal: "1.01",
    highMultiplierConfirmed: false,
    processes: [{
      configurationItemId: itemId,
      processName: "返工工序",
      pricingUnit: "piece",
      multiplier: "1.000",
      highMultiplierReason: null,
      baseAmount: "1.00500000",
      responsibilityAmount: "1.01",
      allocations: [{
        responsibilityType: "own_factory",
        shareBps: 10000,
        roundedAmount: "1.01",
      }],
    }],
  },
};

describe("responsibility production amount view", () => {
  it("exposes base work amounts at three decimals while final money stays at two", () => {
    const normalized = normalizeResponsibilityAmountView(view);

    expect(normalized.sourceProcesses[0]?.baseAmount).toBe("110.000");
    expect(normalized.determination?.processes[0]?.baseAmount).toBe("1.005");
    expect(normalized.determination?.processes[0]?.responsibilityAmount).toBe("1.01");
    expect(normalized.determination?.processes[0]?.allocations[0]?.roundedAmount).toBe("1.01");
  });
});
