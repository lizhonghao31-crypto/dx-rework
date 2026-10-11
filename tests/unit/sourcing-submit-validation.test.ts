import { describe, expect, it } from "vitest";
import { validateSourcingCreate, validateSourcingDecision, validateSourcingPrices } from "../../apps/web/src/sourcing-submit-validation.js";
import { SubmissionCancelled, SubmissionRequestError, submissionFailure } from "../../apps/web/src/submission-validation.js";

const valid = {
  gender: "女装", styleName: "短裤", estimatedCutPieceSendDate: "2026-09-21", deliveryDate: "2026-09-30",
  lineItems: [{ styleNo: "TEST-A", alternateStyleNo: "", color: "白", quantity: "100" }],
  daxingUnitPrice: "12.30", imageCount: 1, uploading: false, uploadFailed: false,
};
describe("外发提交前的真实校验", () => {
  it("accepts existing valid data without changing decimal rules", () => {
    expect(validateSourcingCreate(valid)).toEqual([]);
    expect(validateSourcingCreate({ ...valid, daxingUnitPrice: "12.3000" })).toEqual([]);
  });
  it("requires explicit resolution when recovery exceeds the real attachment limit",()=>{expect(validateSourcingCreate({...valid,imageCount:20})).toEqual([]);expect(validateSourcingCreate({...valid,imageCount:21})).toEqual([expect.objectContaining({fieldId:"sourcing-create-photos",message:expect.stringContaining("主动移除")})]);});
  it("collects all missing fields with distinct navigable targets", () => {
    const issues = validateSourcingCreate({ ...valid, gender: "", styleName: "", estimatedCutPieceSendDate: "", deliveryDate: "",
      daxingUnitPrice: "", imageCount: 0, lineItems: [{ styleNo: "", alternateStyleNo: "", color: "", quantity: "" }] });
    expect(issues.map(issue => issue.fieldId)).toEqual([
      "sourcing-create-gender", "sourcing-create-style", "sourcing-create-send-date", "sourcing-create-delivery-date",
      "sourcing-create-budget", "sourcing-create-style-0", "sourcing-create-color-0", "sourcing-create-quantity-0", "sourcing-create-photos",
    ]);
  });
  it.each(["0", "-1", "1.5", "1e3", "10000001"])("rejects invalid row quantity %s", quantity => {
    expect(validateSourcingCreate({ ...valid, lineItems: [{ ...valid.lineItems[0]!, quantity }] }))
      .toEqual([expect.objectContaining({ fieldId: "sourcing-create-quantity-0" })]);
  });
  it("checks the order total, alternative style number and duplicate row identity", () => {
    expect(validateSourcingCreate({ ...valid, lineItems: [{ ...valid.lineItems[0]!, styleNo: "", alternateStyleNo: "TEST-ALT" }] })).toEqual([]);
    expect(validateSourcingCreate({ ...valid, lineItems: [
      { ...valid.lineItems[0]!, quantity: "6000000" }, { ...valid.lineItems[0]!, styleNo: "TEST-B", quantity: "6000000" },
    ] })).toEqual([expect.objectContaining({ fieldId: "sourcing-create-quantity-0" })]);
    expect(validateSourcingCreate({ ...valid, lineItems: [...valid.lineItems, ...valid.lineItems] }))
      .toEqual([expect.objectContaining({ fieldId: "sourcing-create-style-1" })]);
  });
  it.each(["TEST-FIRST", ""])("targets later duplicate rows while retaining missing fields: %s", firstStyle => {
    const issues = validateSourcingCreate({ ...valid, lineItems: [
      { ...valid.lineItems[0]!, styleNo: firstStyle },
      { ...valid.lineItems[0]!, styleNo: "TEST-B" },
      { ...valid.lineItems[0]!, styleNo: "", alternateStyleNo: " test-b " },
    ] });
    expect(issues.map(issue => issue.fieldId)).toEqual(firstStyle
      ? ["sourcing-create-style-2"] : ["sourcing-create-style-0", "sourcing-create-style-2"]);
    expect(issues.at(-1)?.message).toContain("第 2 行与第 3 行");
  });
  it("rejects case and whitespace variants of craft names before writing", () => {
    expect(validateSourcingDecision({ supplierId: "factory", linePrices: [], decisionReason: "",
      cuttingProcess: "", cuttingProcessOther: "" }, [], [" Cutting ", "cutting"]).map(issue => issue.fieldId))
      .toEqual(["sourcing-decision-process-1"]);
  });
  it.each([{ uploading: true, uploadFailed: false }, { uploading: false, uploadFailed: true }])("blocks an incomplete upload even with older images present: %j", flags => {
    expect(validateSourcingCreate({ ...valid, ...flags })).toEqual([expect.objectContaining({ fieldId: "sourcing-create-photos" })]);
  });
  it("targets each invalid price without rounding it into a valid input", () => {
    expect(validateSourcingPrices("quote", [{ position: 1, unitPrice: "12.30" }, { position: 2, unitPrice: "0" }, { position: 3, unitPrice: "1.231" }])
      .map(issue => issue.fieldId)).toEqual(["sourcing-quote-price-2", "sourcing-quote-price-3"]);
  });
  it("requires a reason for any raised row, without offsetting another row's reduction", () => {
    const input = { supplierId: "factory", linePrices: [{ position: 1, unitPrice: "11" }, { position: 2, unitPrice: "5" }],
      decisionReason: "", cuttingProcess: "", cuttingProcessOther: "" };
    const ie = [{ position: 1, unitPrice: "10" }, { position: 2, unitPrice: "10" }];
    expect(validateSourcingDecision(input, ie, ["车缝"]).map(issue => issue.fieldId)).toEqual(["sourcing-decision-reason"]);
    expect(validateSourcingDecision({ ...input, decisionReason: "已核实" }, ie, ["车缝"])).toEqual([]);
    expect(validateSourcingDecision({ ...input, linePrices: ie }, ie, ["车缝"])).toEqual([]);
  });
  it("collects factory, craft, other-cutting and price issues before resolving crafts", () => {
    expect(validateSourcingDecision({ supplierId: "", linePrices: [{ position: 1, unitPrice: "" }],
      decisionReason: "", cuttingProcess: "other", cuttingProcessOther: "" }, [], ["车缝", "车缝", ""]).map(issue => issue.fieldId))
      .toEqual(["sourcing-decision-factory", "sourcing-decision-price-1", "sourcing-decision-process-1", "sourcing-decision-process-2", "sourcing-decision-cutting-other"]);
  });
});

describe("提交结果分类", () => {
  it.each(["IDEMPOTENCY_IN_PROGRESS", "IDEMPOTENCY_CONFLICT"])("does not mistake %s for a safe opportunity to issue a new key", code => {
    expect(submissionFailure(new SubmissionRequestError("冲突", code, 409)).uncertain).toBe(true);
  });
  it.each([400, 401, 403, 409, 422, 429])("treats a confirmed HTTP %i rejection as definite, preserving its message", status => {
    expect(submissionFailure(new SubmissionRequestError("服务端拒绝原因", "TEST", status)))
      .toMatchObject({ uncertain: false, message: "服务端拒绝原因" });
  });
  it.each([408, 500, 502, 503])("does not claim HTTP %i means no write happened", status => {
    expect(submissionFailure(new SubmissionRequestError("异常", undefined, status)).uncertain).toBe(true);
  });
  it("treats lost responses, aborted writes and invalid successful responses as unknown", () => {
    for (const error of [new TypeError("Failed to fetch"), new DOMException("timeout", "AbortError"), new SyntaxError("invalid JSON")]) {
      expect(submissionFailure(error).uncertain).toBe(true);
    }
  });
  it("does not show a second failure dialog for an explicit duplicate-style cancellation", () => {
    expect(submissionFailure(new SubmissionCancelled("已取消"))).toMatchObject({ cancelled: true, uncertain: false });
  });
});
