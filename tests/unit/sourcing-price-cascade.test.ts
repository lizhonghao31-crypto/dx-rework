import { describe, expect, it } from "vitest";

import { applySourcingPriceCascade } from "../../apps/web/src/sourcing-price-cascade.js";

const lines = () => [
  { position: 1, unitPrice: "11" },
  { position: 2, unitPrice: "11" },
  { position: 3, unitPrice: "11" },
];

describe("sourcing first-line price cascade", () => {
  it("fans a valid first-row price to untouched rows and preserves later manual exceptions", () => {
    let independent: ReadonlySet<number> = new Set();
    let current = applySourcingPriceCascade(lines(), 1, "8.8", independent);
    independent = current.independentPositions;
    expect(current.linePrices.map((line) => line.unitPrice)).toEqual(["8.8", "8.8", "8.8"]);

    current = applySourcingPriceCascade(current.linePrices, 2, "9.1", independent);
    independent = current.independentPositions;
    expect([...independent]).toEqual([2]);
    expect(current.linePrices.map((line) => line.unitPrice)).toEqual(["8.8", "9.1", "8.8"]);

    current = applySourcingPriceCascade(current.linePrices, 1, "8.9", independent);
    expect(current.linePrices.map((line) => line.unitPrice)).toEqual(["8.9", "9.1", "8.9"]);
  });

  it("does not spread empty, incomplete, zero or over-precision first-row drafts", () => {
    for (const value of ["", "8.", "0", "8.801"]) {
      const result = applySourcingPriceCascade(lines(), 1, value, new Set());
      expect(result.linePrices.map((line) => line.unitPrice)).toEqual([value, "11", "11"]);
    }
  });

  it("protects a follower from later first-row changes as soon as that follower is edited", () => {
    const manual = applySourcingPriceCascade(lines(), 3, "10.", new Set());
    expect([...manual.independentPositions]).toEqual([3]);
    const first = applySourcingPriceCascade(
      manual.linePrices,
      1,
      "8.5",
      manual.independentPositions,
    );
    expect(first.linePrices.map((line) => line.unitPrice)).toEqual(["8.5", "8.5", "10."]);
  });

  it("keeps IE and management tracking independent when callers use separate session sets", () => {
    const quote = applySourcingPriceCascade(lines(), 2, "9.3", new Set());
    const decision = applySourcingPriceCascade(lines(), 1, "8.6", new Set());
    expect([...quote.independentPositions]).toEqual([2]);
    expect([...decision.independentPositions]).toEqual([]);
    expect(decision.linePrices.map((line) => line.unitPrice)).toEqual(["8.6", "8.6", "8.6"]);
  });
});
