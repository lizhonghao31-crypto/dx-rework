import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";

describe("sourcing number presentation", () => {
  it("shows grouped values without meaningless trailing zeroes", () => {
    expect(formatBusinessDecimal("4.5000")).toBe("4.5");
    expect(formatBusinessDecimal("4.0000")).toBe("4");
    expect(formatBusinessDecimal("15052.50")).toBe("15,052.5");
    expect(formatBusinessDecimal("3345")).toBe("3,345");
  });

  it("uses formatted values for every sourcing money and quantity input", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain("const businessInputValue");
    expect(page).toContain("const businessInputChange");
    expect(page).toContain("const [activeBusinessInput, setActiveBusinessInput]");
    const priceInput = await readFile("apps/web/src/sourcing-price-input.ts", "utf8");
    expect(priceInput).toContain("newSourcingPriceDisplay(accepted)");
    expect(page).toContain("linesTotalPreview(quote.linePrices, item.lineItems)");
    expect(page).toContain("linesTotalPreview(decision.linePrices, item.lineItems)");
    expect(page).toContain('priceInput("quote", line.position, price)');
    expect(page).toContain('priceInput("decision", line.position, price)');
    expect(page).toContain('onBlur={() => setActiveBusinessInput(null)}');
    expect(page).not.toContain("value={decision.unitPrice} inputMode=\"decimal\"");
    expect(page).not.toContain("value={finance.totalAmount} inputMode=\"decimal\"");
  });
});
