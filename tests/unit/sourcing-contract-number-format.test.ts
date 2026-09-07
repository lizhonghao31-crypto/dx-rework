import { describe, expect, it } from "vitest";
import { formatSourcingContractPrice } from "../../apps/api/src/sourcing/sourcing-contract-pdf.js";

describe("contract price presentation preserves approved facts", () => {
  it("groups new ordinary prices without meaningless storage zeroes", () => {
    expect(formatSourcingContractPrice("1200.3400")).toBe("1,200.34");
    expect(formatSourcingContractPrice("12.3000")).toBe("12.3");
    expect(formatSourcingContractPrice("12.0000")).toBe("12");
  });
  it("does not round historical or deferred transfer prices", () => {
    expect(formatSourcingContractPrice("176.1933")).toBe("176.1933");
    expect(formatSourcingContractPrice("0.0050")).toBe("0.0050");
  });
});
