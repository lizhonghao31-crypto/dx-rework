import { describe, expect, it } from "vitest";
import {
  calculateSourcingTotalExact, calculateSourcingLinesTotalExact, CreateSourcingCaseSchema,
  CreateSourcingIeQuoteSchema, RecordSourcingManagementDecisionSchema,
  RequestSourcingFactoryChangeSchema, type SourcingCaseSummary,
} from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { isNewSourcingPrice, newSourcingPriceDisplay, historicalSourcingPrice, sourcingPriceSummary, sourcingLinePricing, sourcingDeleteConfirmation, sourcingDecisionNeedsReason } from "../../apps/web/src/sourcing-price-presentation.js";

describe("ordinary sourcing price precision and readable facts", () => {
  it("requires a reason only for a position-matched increase, including mixed changes", () => {
    const quoted = [{ position: 1, unitPrice: "12.3000" }, { position: 2, unitPrice: "8.6100" }];
    expect(sourcingDecisionNeedsReason([{ position: 2, unitPrice: "8.61" }, { position: 1, unitPrice: "0012.30" }], quoted)).toBe(false);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "12.30" }, { position: 2, unitPrice: "8.62" }], quoted)).toBe(true);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "12.34" }], [{ position: 1, unitPrice: "12.3456" }])).toBe(false);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "10.8" }], [{ position: 1, unitPrice: "17" }])).toBe(false);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "17.0000" }], [{ position: 1, unitPrice: "17.00" }])).toBe(false);
    expect(sourcingDecisionNeedsReason([{ position: 2, unitPrice: "8.62" }, { position: 1, unitPrice: "1" }], quoted)).toBe(true);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "17.01" }], [{ position: 1, unitPrice: "17" }])).toBe(true);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "" }], quoted)).toBe(false);
    expect(sourcingDecisionNeedsReason([{ position: 1, unitPrice: "12.30" }], [])).toBe(false);
  });
  it("accepts two effective decimals including storage zeroes, without silently rounding", () => {
    for (const price of ["12", "12.3", "12.34", "12.3400"]) expect(isNewSourcingPrice(price)).toBe(true);
    for (const price of ["12.3456", "12.301", "0.001", "0", "1,200.34", "-1", ""]) expect(isNewSourcingPrice(price)).toBe(false);
    expect(newSourcingPriceDisplay("12.3456")).toBe("12.3456");
    expect(newSourcingPriceDisplay("1234.5000")).toBe("1,234.5");
    expect(CreateSourcingIeQuoteSchema.safeParse({ unitPrice: "12.3456" }).success).toBe(false);
    expect(RecordSourcingManagementDecisionSchema.safeParse({ supplierId: "00000000-0000-4000-8000-000000000200", craftIds: ["00000000-0000-4000-8000-000000000401"], linePrices: [{ position: 1, unitPrice: "12.3456" }] }).success).toBe(false);
  });

  it("requires at least one creation image and rejects hidden four-place initial prices", () => {
    const input = { gender: "男装", styleName: "短裤", estimatedCutPieceSendDate: "2026-09-10", deliveryDate: "2026-09-15",
      lineItems: [{ styleNo: "TEST", color: "黑", quantity: 120, externalUnitPrice: "12.34" }], daxingUnitPrice: "10.25",
      attachmentIds: ["00000000-0000-4000-8000-000000000301"] };
    expect(CreateSourcingCaseSchema.safeParse(input).success).toBe(true);
    for (const fields of [{ attachmentIds: [] }, { attachmentIds: undefined }, { daxingUnitPrice: "10.251" }]) {
      expect(CreateSourcingCaseSchema.safeParse({ ...input, ...fields }).success).toBe(false);
    }
  });

  it("keeps legacy and deferred transfer precision while new visible prices explain totals", () => {
    expect(calculateSourcingTotalExact("176.1933", 54550)).toBe("9611344.52");
    expect(RequestSourcingFactoryChangeSchema.safeParse({ supplierId: "00000000-0000-4000-8000-000000000200", unitPrice: "12.3456", changeReason: "既有转厂契约回归" }).success).toBe(true);
    expect(calculateSourcingLinesTotalExact([{ unitPrice: "12.34", quantity: 120 }, { unitPrice: "9.5", quantity: 3 }])).toBe("1509.30");
    expect(formatBusinessCurrency("1509.30")).toBe("¥1,509.3");
    expect(formatBusinessDecimal(54550)).toBe("54,550");
    expect(historicalSourcingPrice("1234.5678")).toBe("¥1,234.5678");
    expect(historicalSourcingPrice("1.2300")).toBe("¥1.23");
    expect(sourcingPriceSummary({unitPrice:"1.2345",linePrices:[{unitPrice:"1.2345"}]})).toBe("¥1.2345");
  });

  it("never presents the first line as the price of a multi-line order", () => {
    expect(sourcingPriceSummary({ unitPrice: "99", linePrices: [{ unitPrice: "12.34" }, { unitPrice: "9.50" }] })).toContain("多款价");
    expect(sourcingPriceSummary({ unitPrice: "99", linePrices: [{ unitPrice: "12.34" }] })).toBe("¥12.34");
    expect(sourcingPriceSummary(null)).toBe("—");
    expect(sourcingPriceSummary({ sourceType: "factory_change", unitPrice: "99", linePrices: [{ unitPrice: "12.34" }, { unitPrice: "9.50" }] })).toBe("¥99");
  });

  it("preserves legacy facts and never labels old line snapshots as current transfer prices", () => {
    const historical = { unitPrice: "12.3456", totalAmount: "123.46", linePrices: [] };
    expect(sourcingLinePricing(historical, 1, 1)).toEqual({ unitPrice: "12.3456", totalAmount: "123.46" });
    expect(sourcingLinePricing(historical, 1, 2)).toBeNull();
    expect(sourcingLinePricing(null, 1, 1)).toBeNull();
    const current = { ...historical, linePrices: [{ position: 2, unitPrice: "8.61", totalAmount: "86.10" }] };
    expect(sourcingLinePricing(current, 2, 2)).toEqual({ unitPrice: "8.61", totalAmount: "86.10" });
    expect(sourcingLinePricing(current, 1, 2)).toBeNull();
    const transfer = { ...current, sourceType: "factory_change", unitPrice: "9.1234", totalAmount: "182.47" };
    expect(sourcingLinePricing(transfer, 2, 2)).toEqual({ unitPrice: "9.1234", totalAmount: null });
    expect(sourcingLinePricing(transfer, 1, 1)).toEqual({ unitPrice: "9.1234", totalAmount: "182.47" });
  });

  it("identifies deletion by readable styles, supplier, quantity and downstream impact", () => {
    const message = sourcingDeleteConfirmation({ sourcingCaseId: "stable-case-id", erpOrderNo: "DX-TEST", orderQuantity: 1200,
      lineItems: [{ styleNo: "K001", color: "蓝" }], decision: { supplierName: "合成加工厂" } } as SourcingCaseSummary);
    for (const fact of ["K001 / 蓝", "合成加工厂", "1,200", "历史证据保留", "关联生产单不会自动", "stable-case-id"]) expect(message).toContain(fact);
  });
});
