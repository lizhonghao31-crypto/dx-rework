import { describe, expect, it } from "vitest";

import { CreateSourcingCaseSchema } from "@dx-rework/contracts";

const base = {
  erpOrderNo: "ERP-CRAFT-001",
  estimatedCutPieceSendDate: "2026-09-25",
  deliveryDate: "2026-09-30",
  lineItems: [{
    styleNo: "CRAFT-001",
    color: "黑色",
    quantity: 80,
    externalUnitPrice: "12.0000",
  }],
  daxingUnitPrice: "10.0000",
};

describe("sourcing order craft contract", () => {
  it("accepts an ordered unique craft id list", () => {
    expect(CreateSourcingCaseSchema.parse({
      ...base,
      craftIds: [
        "00000000-0000-4000-8000-000000000002",
        "00000000-0000-4000-8000-000000000001",
      ],
    }).craftIds).toEqual([
      "00000000-0000-4000-8000-000000000002",
      "00000000-0000-4000-8000-000000000001",
    ]);
  });

  it("rejects duplicate ids and mixed legacy craft sources", () => {
    const craftId = "00000000-0000-4000-8000-000000000001";
    expect(CreateSourcingCaseSchema.safeParse({
      ...base,
      craftIds: [craftId, craftId],
    }).success).toBe(false);
    expect(CreateSourcingCaseSchema.safeParse({
      ...base,
      craftIds: [craftId],
      processes: ["钉扣"],
    }).success).toBe(false);
  });
});
