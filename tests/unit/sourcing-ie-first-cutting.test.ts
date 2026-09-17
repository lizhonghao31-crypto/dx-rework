import { CreateSourcingCaseSchema, RecordSourcingManagementDecisionSchema } from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

const uuid = "00000000-0000-4000-8000-000000000001";
const order = {
  gender: "女装", styleName: "上衣", estimatedCutPieceSendDate: "2026-09-18", deliveryDate: "2026-09-30",
  lineItems: [{ styleNo: "IE-FIRST", color: "黑", quantity: 1250 }], daxingUnitPrice: "16.20", attachmentIds: [uuid],
};
const decision = { supplierId: uuid, craftIds: [uuid], linePrices: [{ position: 1, unitPrice: "12.35" }] };
describe("IE first quote and internal cutting process", () => {
  it("accepts a new order without manufacturing prices and still requires a budget and quantity", () => {
    expect(CreateSourcingCaseSchema.parse(order).lineItems[0]).not.toHaveProperty("externalUnitPrice");
    expect(CreateSourcingCaseSchema.safeParse({ ...order, daxingUnitPrice: "" }).success).toBe(false);
    expect(CreateSourcingCaseSchema.safeParse({ ...order, lineItems: [{ ...order.lineItems[0], quantity: 0 }] }).success).toBe(false);
  });
  it("accepts the fixed cutting choices and requires meaningful text only for other", () => {
    for (const cuttingProcess of ["in_house", "outsourced"]) {
      expect(RecordSourcingManagementDecisionSchema.parse({ ...decision, cuttingProcess }).cuttingProcess).toBe(cuttingProcess);
    }
    expect(RecordSourcingManagementDecisionSchema.parse({ ...decision, cuttingProcess: "other", cuttingProcessOther: " 指定裁床 " }).cuttingProcessOther).toBe("指定裁床");
    for (const fields of [
      { cuttingProcess: "other" }, { cuttingProcess: "other", cuttingProcessOther: " " },
      { cuttingProcess: "in_house", cuttingProcessOther: "不匹配" }, { cuttingProcess: "unknown" },
    ]) expect(RecordSourcingManagementDecisionSchema.safeParse({ ...decision, ...fields }).success).toBe(false);
    expect(RecordSourcingManagementDecisionSchema.safeParse(decision).success).toBe(true);
  });
});
