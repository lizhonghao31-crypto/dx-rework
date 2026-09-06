import { describe, expect, it } from "vitest";
import { normalizeSampleMoneyFields } from "../../apps/web/src/sample-money-input.js";
import { SampleDisposalRequestSchema, SampleDisposalDecisionSchema, SampleFinanceCorrectionSchema } from "../../packages/contracts/src/sample-disposal.js";

describe("sample monetary form input", () => {
  const proof = "a9c8de26-c440-4683-894b-6169dff98f06";
  it.each([["100", "100.00"], ["100.5", "100.50"], ["100.50", "100.50"], [" 0.01 ", "0.01"], ["999999999999.99", "999999999999.99"]])("accepts %s across sale, approval and finance forms", (input, expected) => {
    const sale = normalizeSampleMoneyFields({ version: 1, type: "sale", recipient: "TEST", amount: input, proofAttachmentIds: [proof] });
    expect(SampleDisposalRequestSchema.parse(sale)).toMatchObject({ amount: expected });
    expect(SampleDisposalDecisionSchema.parse(normalizeSampleMoneyFields({ version: 1, decision: "approve", finalAmount: input }))).toMatchObject({ finalAmount: expected });
    expect(SampleFinanceCorrectionSchema.parse(normalizeSampleMoneyFields({ version: 1, reason: "TEST", purchasePrice: input }))).toMatchObject({ purchasePrice: expected });
  });
  it.each(["", " ", "-1", "1.234", "1e2", "1,000", "01", ".5", "1.", "1000000000000", "NaN", "Infinity"])("rejects invalid input %s without truncation", value => {
    expect(() => normalizeSampleMoneyFields({ amount: value })).toThrow("金额必须为非负数字，最多两位小数");
  });
  it("preserves zero-price rules but rejects zero sale and compensation", () => {
    expect(SampleFinanceCorrectionSchema.parse(normalizeSampleMoneyFields({ version: 1, reason: "TEST", purchasePrice: "0" })).purchasePrice).toBe("0.00");
    expect(SampleDisposalDecisionSchema.safeParse(normalizeSampleMoneyFields({ version: 1, decision: "approve", finalAmount: "0" })).success).toBe(false);
    expect(SampleDisposalRequestSchema.safeParse(normalizeSampleMoneyFields({ version: 1, type: "sale", recipient: "TEST", amount: "0", proofAttachmentIds: [proof] })).success).toBe(false);
  });
  it("does not mutate the draft or alter non-monetary actions and evidence", () => {
    const draft = { version: 2, type: "sale", amount: "12.3", proofAttachmentIds: [proof], recipient: "TEST" };
    const result = normalizeSampleMoneyFields(draft);
    expect(draft.amount).toBe("12.3");
    expect(result.proofAttachmentIds).toBe(draft.proofAttachmentIds);
    expect(result).toEqual({ ...draft, amount: "12.30" });
    const rejection = { version: 2, decision: "reject", reason: "TEST" };
    expect(normalizeSampleMoneyFields(rejection)).toEqual(rejection);
  });
});
