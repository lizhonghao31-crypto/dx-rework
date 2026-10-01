import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BudgetDocumentSchema, budgetDisplayAmount, budgetPublishErrors, calculateBudget, type BudgetDocument, type BudgetRow } from "../../packages/contracts/src/digital-budget.js";

const row = (section: BudgetRow["section"], consumption: string, unitPrice: string): BudgetRow => ({ rowId: randomUUID(), section, category: "", name: "测试物料", specification: "", unit: "", supplier: "厂供", consumption, unitPrice });
const document = (): BudgetDocument => ({ fabricType: "针织", productCategory: "套装", monthSeries: "", date: "2026-09-30", currency: "人民币", rows: [], freight: "0.3", cm: "8.3", salePrice: "48", outsourcingScope: "裁、车、烫、包装", outsourcingUnitPrice: "8.3", imageAttachmentIds: [] });
describe("P09 原预算公式与发布边界", () => {
  it("逐项重算原件样例，保留44.399与3.601而非累计显示值", () => {
    const doc = document();
    doc.rows = [row("主料", "0.52", "20"), row("主料", "0.53", "28.5"), row("主料", "0.05", "27.5"),
      ...["0.3", "0.34", "0.7", "0.35", "0.5", "0.5", "0.25", "1.2"].map(price => row("辅料", "1", price)),
      row("辅料", "0.55", "0.3"), row("辅料", "2", "0.7"), row("辅料", "0.07", "0.2"), row("外发工序", "1", "3.2")];
    const result = calculateBudget(doc);
    expect(result).toMatchObject({ main: "26.88", accessories: "5.719", processes: "3.2", cost: "44.399", profit: "3.601" });
    expect(budgetDisplayAmount(result.cost)).toBe("44.40");
    expect(budgetDisplayAmount(result.profit!)).toBe("3.60");
  });
  it("空行不影响总数，增行计入所属小计，缺销售价保留未知利润", () => {
    const doc = document(); doc.rows = [row("主料", "", ""), row("辅料", "0.000001", "0.000001")]; doc.salePrice = "";
    expect(calculateBudget(doc)).toMatchObject({ accessories: "0.000000000001", cost: "8.600000000001", profit: null });
    expect(budgetPublishErrors(doc)).toContain("有内容的预算行须填写物料或工序、单件用量和单价");
    doc.rows[0]!.name = "";
    expect(budgetPublishErrors(doc)).toEqual([]);
  });
  it("负利润、半分舍入和大数都不经过浮点", () => {
    expect(budgetDisplayAmount("-3.605")).toBe("-3.61");
    expect(budgetDisplayAmount("-0.001")).toBe("0.00");
    const doc = document(); doc.rows = [row("主料", "9999999999.999999", "9999999999.999999")];
    expect(calculateBudget(doc).main).toBe("99999999999999980000.000000000001");
    expect(budgetDisplayAmount("99999999999999980000.000000000001")).toBe("99,999,999,999,999,980,000.00");
  });
  it("拒绝NaN、指数、负数和重复行，预算价与CM保持分离", () => {
    for (const value of ["NaN", "1e3", "-1", "1.0000001"]) expect(BudgetDocumentSchema.safeParse({ ...document(), cm: value }).success).toBe(false);
    const doc = document(); doc.rows = [row("主料", "1", "2")]; doc.rows.push(doc.rows[0]!);
    expect(BudgetDocumentSchema.safeParse(doc).success).toBe(false);
    doc.rows = []; doc.cm = "8.3"; doc.outsourcingUnitPrice = "5.25";
    expect(calculateBudget(doc).cost).toBe("8.6");
    expect(budgetPublishErrors(doc)).toEqual([]);
    expect(budgetPublishErrors({ ...doc, outsourcingUnitPrice: "5.251" })).toContain("外发预算价最多两位有效小数");
  });
});
