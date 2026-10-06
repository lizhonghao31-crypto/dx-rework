import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { initialInstruction, type InstructionDocument } from "@dx-rework/contracts/production-instruction";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import { instructionIssues } from "../../apps/web/src/production-instruction-validation.js";

const lineId = randomUUID(), secondLineId = randomUUID();
const order = { lines: [{ lineId, color: "蓝", sizes: [{ size: "M", quantity: 10 }] }, { lineId: secondLineId, color: "蓝", sizes: [{ size: "L", quantity: 5 }] }] } as DigitalOrder;
const document = (): InstructionDocument => ({ ...initialInstruction(), styleName: "TEST上衣", category: "上衣", date: "2026-10-06", preshrink: "无需预缩", sizes: ["M", "L"], images: [{ attachmentId: randomUUID(), kind: "款图", description: "原说明" }], measurements: [{ id: randomUUID(), name: "袖长", tolerance: "±1/4", method: "沿原量法", values: ["6 1/8", "6 3/8"] }] });
describe("DOC03 original rules and cross-tab error targets", () => {
  it("allows an incomplete draft and preserves fractions and empty optional tables", () => {
    expect(instructionIssues(initialInstruction(), order)).toEqual([]);
    const doc = document(), original = structuredClone(doc);
    expect(instructionIssues(doc, order, true)).toEqual([]);
    expect(doc).toEqual(original);
  });
  it("locates missing image and measurement values in the correct hidden tab", () => {
    const doc = document(); doc.images = []; doc.measurements[0]!.values[1] = "";
    const issues = instructionIssues(doc, order, true);
    expect(issues).toContainEqual(expect.objectContaining({ tab: "images", id: "instruction-upload", message: "请上传或沿用款图" }));
    expect(issues).toContainEqual(expect.objectContaining({ tab: "measurements", id: `instruction-measurement-${doc.measurements[0]!.id}-value-1` }));
  });
  it("uses mother line identities even for equal color names and rejects an unrelated identity", () => {
    const doc = document(); doc.fabrics = [{ id: randomUUID(), name: "面料", part: "主布", colors: { [lineId]: "一号色", [secondLineId]: "二号色" }, remarks: "" }];
    expect(instructionIssues(doc, order, true)).toEqual([]);
    doc.fabrics[0]!.colors[randomUUID()] = "同名不能猜对应";
    expect(instructionIssues(doc, order, true)).toContainEqual({ tab: "fabrics", id: "instruction-fabrics", label: "面料单 · 款色对应", message: "面料颜色必须对应母单款色" });
  });
  it("maps packaging schema errors to the same stable accessory, preserving the shared array", () => {
    const doc = document(), id = randomUUID();
    doc.accessories = [{ id, group: "包装", garmentColors: "蓝", materialColor: "白", name: "吊牌", category: "纸品", part: "衣领", specification: "x".repeat(201), consumption: "1张", remarks: "" }];
    expect(instructionIssues(doc, order)).toContainEqual(expect.objectContaining({ tab: "packaging", id: `instruction-accessory-${id}-specification` }));
  });
});
