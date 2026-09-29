import { describe, expect, it } from "vitest";
import { DigitalOrderCreateSchema, DigitalSourceCreateSchema, DigitalNumberCorrectionSchema } from "@dx-rework/contracts/digital-production";
describe("digital production identity input", () => {
  const valid = { customerCode: "PD", productGroup: "男装", designStyleNo: "D1", orderDate: "2026-09-29", lines: [{ color: "黑", sizes: [{ size: "M", quantity: 10 }] }] };
  it("permits missing formal numbers without losing distinct fields", () => {
    const parsed = DigitalOrderCreateSchema.parse(valid);
    expect(parsed.lines[0]?.formalStyleNo).toBeNull(); expect(parsed.lines[0]?.poNumber).toBeNull();
  });
  it("rejects duplicate colors after whitespace and case normalization", () => {
    expect(DigitalOrderCreateSchema.safeParse({ ...valid, lines: [
      { color: "Blue", sizes: [{ size: "M", quantity: 1 }] },
      { color: " blue ", sizes: [{ size: "L", quantity: 2 }] },
    ] }).success).toBe(false);
  });
  it("rejects invented types, unknown fields, invalid dates and duplicate sizes", () => {
    expect(DigitalSourceCreateSchema.safeParse({ developmentType: "复版", designStyleNo: "D1" }).success).toBe(false);
    expect(DigitalOrderCreateSchema.safeParse({ ...valid, dueAt: "tomorrow" }).success).toBe(false);
    expect(DigitalOrderCreateSchema.safeParse({ ...valid, orderDate: "2026-02-30" }).success).toBe(false);
    expect(DigitalOrderCreateSchema.safeParse({ ...valid, lines: [{ color: "黑", sizes: [{ size: "M", quantity: 1 }, { size: "M", quantity: 2 }] }] }).success).toBe(false);
    expect(DigitalNumberCorrectionSchema.safeParse({ expectedVersion: 1, quantity: 2 }).success).toBe(false);
  });
});
