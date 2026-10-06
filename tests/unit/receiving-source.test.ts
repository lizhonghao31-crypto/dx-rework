import { describe, expect, it } from "vitest";
import { hasExistingReceivingSource } from "../../apps/web/src/receiving-source.js";

describe("receiving source preflight", () => {
  const blue = { styleNo: "TEST-B-FORMAL", cuttingOrderId: "blue-cutting" };
  it("allows a different PO/color cutting source to receive the same style initially", () => {
    expect(hasExistingReceivingSource([blue], blue.styleNo, "red-cutting")).toBe(false);
  });
  it("routes the same cutting source to repeat receiving", () => {
    expect(hasExistingReceivingSource([blue], blue.styleNo, blue.cuttingOrderId)).toBe(true);
  });
  it("does not mistake a legacy style-only receipt for an explicit cutting source", () => {
    expect(hasExistingReceivingSource([{ styleNo: blue.styleNo }], blue.styleNo, "red-cutting")).toBe(false);
  });
  it("keeps normalized style grouping for legacy input", () => {
    expect(hasExistingReceivingSource([blue], "  test-b-formal  ")).toBe(true);
    expect(hasExistingReceivingSource([{ styleNo: "  test-b-formal " }], blue.styleNo)).toBe(true);
  });
  it("does not route an unrelated or empty result into repeat receiving", () => {
    expect(hasExistingReceivingSource([blue], "TEST-C-FORMAL")).toBe(false);
    expect(hasExistingReceivingSource([], blue.styleNo, blue.cuttingOrderId)).toBe(false);
  });
});
