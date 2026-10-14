import { InspectionReportDraftSchema, InspectionReportSchema, ReviewWholeOrderSchema } from "../../packages/contracts/src/index.js";
import { completeInspectionReport } from "../inspection-report-fixture.js";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { configureChineseValidation, requestValidationMessage } from "../../packages/contracts/src/validation-language.js";
const previous = { ...z.config() };
afterEach(() => { z.config(previous); });
describe("Chinese validation preserves constraints and domain messages", () => {
  it("localizes fixed legacy schema errors with their field and keeps draft/publication rules distinct", () => {
    const draft = { ...completeInspectionReport(), inspectionLocation: null };
    expect(InspectionReportDraftSchema.safeParse(draft).success).toBe(true);
    const published = InspectionReportSchema.safeParse(draft);
    expect(published.success).toBe(false);
    expect(published.error?.issues.find(issue => issue.path[0] === "inspectionLocation")?.message).toBe("验货地点：请填写此项");
  });
  it("keeps three-decimal money constraints and returns Chinese custom reasons", () => {
    const id = "550e8400-e29b-41d4-a716-446655440000";
    const valid = { expectedOrderVersion: 1, processPrices: [{ configurationItemId: id, unitPrice: 1.123 }], temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.123, reason: "TEST" }] };
    expect(ReviewWholeOrderSchema.safeParse(valid).success).toBe(true);
    const invalid = ReviewWholeOrderSchema.safeParse({ ...valid, processPrices: [{ configurationItemId: id, unitPrice: 1.1234 }], temporaryCoefficients: [{ ...valid.temporaryCoefficients[0], multiplier: 1.1234 }] });
    expect(invalid.success).toBe(false);
    if (invalid.success) return;
    const message = requestValidationMessage(invalid);
    expect(message).toContain("单价最多保留三位小数");
    expect(message).toContain("倍数最多保留三位小数");
    expect(message).not.toMatch(/Unit price|Multiplier/);
  });
  it("locates nested rows without exposing submitted values and retains schema business reasons", () => {
    configureChineseValidation();
    const schema = z.object({ items: z.array(z.object({ quantity: z.number().min(1), supplierId: z.uuid() })) });
    const result = schema.safeParse({ items: [{ quantity: 0, supplierId: "PRIVATE-SUBMITTED-VALUE" }] });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = requestValidationMessage(result);
    expect(message).toContain("明细 / 第1行 / 数量");
    expect(message).toContain("明细 / 第1行 / 加工厂");
    expect(message).not.toContain("PRIVATE-SUBMITTED-VALUE");
    expect(message).not.toContain("Invalid input");
    expect(z.string().min(1, "提交审批时请填写退回原因").safeParse("").error?.issues[0]?.message).toBe("提交审批时请填写退回原因");
  });
  it("leaves optional drafts valid and rejects unknown options without changing the schema", () => {
    configureChineseValidation();
    const schema = z.object({ note: z.string().optional(), status: z.enum(["pending", "done"]).optional() });
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ status: "unknown" }).error?.issues[0]?.message).toBe("状态：请选择已有的有效选项");
    expect(requestValidationMessage({})).toBe("提交资料格式不正确，请检查填写内容");
  });
});
