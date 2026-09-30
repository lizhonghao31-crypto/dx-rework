import { describe, expect, it } from "vitest";
import { PatternStoppedHoursSchema, PatternWorkAmountSchema, RequestPatternReworkSchema } from "@dx-rework/contracts/pattern-orders";

describe("pattern rework and stopped-labor input", () => {
  it("accepts explicit zero and exact partial amounts without interpreting blank as zero", () => {
    expect(PatternWorkAmountSchema.parse("0")).toBe("0.000");
    expect(PatternWorkAmountSchema.parse("25.125")).toBe("25.125");
    expect(PatternWorkAmountSchema.parse("99999999999999000")).toBe("99999999999999000.000");
    for (const value of ["", "-1", "1.0001", "1e3"]) expect(PatternWorkAmountSchema.safeParse(value).success).toBe(false);
    expect(PatternStoppedHoursSchema.parse("0")).toBe("0.0");
    expect(PatternStoppedHoursSchema.parse("1.2")).toBe("1.2");
    for (const value of ["", "-0.1", "1.25", "1e2"]) expect(PatternStoppedHoursSchema.safeParse(value).success).toBe(false);
  });
  it("requires a reason and rejects creator-supplied automatic rework pricing", () => {
    const input = { version: 1, roundId: "11111111-1111-4111-8111-111111111111", reason: "修改要求", reasonCategory: "customer_change" };
    expect(RequestPatternReworkSchema.safeParse(input).success).toBe(true);
    expect(RequestPatternReworkSchema.safeParse({ ...input, reason: " " }).success).toBe(false);
    expect(RequestPatternReworkSchema.safeParse({ ...input, amount: "40" }).success).toBe(false);
    expect(RequestPatternReworkSchema.parse(input).retainedAttachmentIds).toBeUndefined();
    expect(RequestPatternReworkSchema.parse({ ...input, retainedAttachmentIds: [] }).retainedAttachmentIds).toEqual([]);
    const attachmentId = "22222222-2222-4222-8222-222222222222";
    expect(RequestPatternReworkSchema.safeParse({ ...input, retainedAttachmentIds: [attachmentId, attachmentId] }).success).toBe(false);
  });
});
