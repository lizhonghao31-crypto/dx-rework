import {
  CreateSourcingIeQuoteSchema,
  RecordSourcingManagementDecisionSchema,
  SourcingLinePriceReviewSchema,
  calculateSourcingLinesTotalExact,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("SSP-04 per-line price contracts", () => {
  it("validates unique line positions with independent exact prices", () => {
    expect(SourcingLinePriceReviewSchema.parse({
      linePrices: [
        { position: 1, unitPrice: "12.3456" },
        { position: 2, unitPrice: "9.5000" },
      ],
      reason: "逐款复核标准工时",
    }).linePrices).toHaveLength(2);

    expect(() => SourcingLinePriceReviewSchema.parse({
      linePrices: [
        { position: 1, unitPrice: "12.0000" },
        { position: 1, unitPrice: "13.0000" },
      ],
    })).toThrow(/不能重复/);
  });

  it("sums rounded line amounts without floating-point drift", () => {
    expect(calculateSourcingLinesTotalExact([
      { unitPrice: "12.3456", quantity: 120 },
      { unitPrice: "9.5000", quantity: 3 },
    ])).toBe("1509.97");
    expect(calculateSourcingLinesTotalExact([
      { unitPrice: "0.0050", quantity: 1 },
      { unitPrice: "0.0050", quantity: 1 },
    ])).toBe("0.02");
  });

  it("rejects empty reviews and invalid precision", () => {
    expect(() => SourcingLinePriceReviewSchema.parse({ linePrices: [] })).toThrow();
    expect(() => SourcingLinePriceReviewSchema.parse({
      linePrices: [{ position: 1, unitPrice: "12.34567" }],
    })).toThrow();
  });

  it("uses per-line prices for new calls and keeps single-line API compatibility", () => {
    expect(CreateSourcingIeQuoteSchema.parse({
      linePrices: [{ position: 1, unitPrice: "12.3000" }],
    }).linePrices).toEqual([{ position: 1, unitPrice: "12.3000" }]);
    expect(CreateSourcingIeQuoteSchema.parse({ unitPrice: "8.5" }).linePrices)
      .toEqual([{ position: 1, unitPrice: "8.5" }]);
    expect(RecordSourcingManagementDecisionSchema.parse({
      craftIds: ["00000000-0000-4000-8000-000000000401"],
      supplierId: "11111111-1111-4111-8111-111111111111",
      linePrices: [
        { position: 1, unitPrice: "12.0000" },
        { position: 2, unitPrice: "13.0000" },
      ],
    }).linePrices).toHaveLength(2);
    expect(() => CreateSourcingIeQuoteSchema.parse({
      unitPrice: "8.5",
      linePrices: [{ position: 1, unitPrice: "8.5" }],
    })).toThrow(/逐款价格/);
  });
});
