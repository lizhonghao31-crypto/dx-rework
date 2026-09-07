import { describe, expect, it } from "vitest";

import { CreateSourcingCaseSchema, RecordSourcingManagementDecisionSchema } from "@dx-rework/contracts";

const base = { supplierId: "00000000-0000-4000-8000-000000000003", unitPrice: "12.0000" };

describe("node 3 craft responsibility contract", () => {
  it("accepts an ordered unique craft id list", () => {
    expect(RecordSourcingManagementDecisionSchema.parse({
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
    expect(RecordSourcingManagementDecisionSchema.safeParse({
      ...base,
      craftIds: [craftId, craftId],
    }).success).toBe(false);
    expect(RecordSourcingManagementDecisionSchema.safeParse({
      ...base,
      craftIds: [craftId],
      processes: ["钉扣"],
    }).success).toBe(false);
  });
  it("requires gender and style in node 1 and rejects removed inputs", () => {
    const order = {
      gender: "男装", styleName: "梭织短裤", estimatedCutPieceSendDate: "2026-09-25", deliveryDate: "2026-09-30",
      lineItems: [{ styleNo: "S001", color: "黑色", quantity: 80, externalUnitPrice: "12.0000" }], daxingUnitPrice: "9.0000",
      attachmentIds: ["00000000-0000-4000-8000-000000000301"],
    };
    expect(CreateSourcingCaseSchema.parse(order).styleName).toBe("梭织短裤");
    for (const invalid of [{ gender: undefined }, { gender: "" }, { gender: "其他" }, { styleName: undefined }, { styleName: " " }, { erpOrderNo: "ERP-1" }, { craftIds: [] }]) {
      expect(CreateSourcingCaseSchema.safeParse({ ...order, ...invalid }).success).toBe(false);
    }
    expect(RecordSourcingManagementDecisionSchema.safeParse(base).success).toBe(false);
  });
});
