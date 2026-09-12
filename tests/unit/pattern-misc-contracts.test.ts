import { describe, expect, it } from "vitest";
import { CreateMiscOrderSchema, PatternHoursSchema } from "@dx-rework/contracts/pattern-orders";

describe("misc task input boundaries", () => {
  it("accepts a task without a style or file and rejects a creator-supplied price", () => {
    expect(CreateMiscOrderSchema.parse({ taskName: "整理样板", priceVersion: 1 })).toMatchObject({ styleNo: "", attachmentIds: [] });
    expect(CreateMiscOrderSchema.safeParse({ taskName: "整理样板", priceVersion: 1, unitPrice: "10.000" }).success).toBe(false);
    expect(CreateMiscOrderSchema.safeParse({ taskName: "  ", priceVersion: 1 }).success).toBe(false);
  });
  it("validates positive decimal tenths without binary rounding or throwing on malformed input", () => {
    for (const value of ["0", "0.0", "1.25", "-0.1", "1e2", "NaN", "Infinity", "", " 1.2", "01.2", "1000000.0"]) {
      expect(PatternHoursSchema.safeParse(value).success, value).toBe(false);
    }
    expect(PatternHoursSchema.parse("0.1")).toBe("0.1");
    expect(PatternHoursSchema.parse("1.2")).toBe("1.2");
    expect(PatternHoursSchema.parse("12")).toBe("12.0");
    expect(PatternHoursSchema.parse("999999.9")).toBe("999999.9");
  });
});
