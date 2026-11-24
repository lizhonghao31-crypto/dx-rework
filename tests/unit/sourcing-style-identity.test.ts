import { describe, expect, it } from "vitest";
import { duplicateSourcingLineMessage, normalizeSourcingStyleNumber, sourcingStyleNumbers } from "../../packages/contracts/src/sourcing-style-identity.js";
import { CorrectSourcingCaseSchema, CreateSourcingCaseSchema, ReviseSourcingStylesSchema } from "../../packages/contracts/src/sourcing.js";

describe("sourcing style identity checks", () => {
  it("blocks same-color collisions across formal and temporary identifiers", () => {
    expect(duplicateSourcingLineMessage([
      {styleNo:" DX-01 ",alternateStyleNo:"TEMP-A",color:" Black "},
      {styleNo:"DX-02",alternateStyleNo:"dx-01",color:"black"},
    ])).toContain("第 1 行与第 2 行");
    expect(duplicateSourcingLineMessage([
      {alternateStyleNo:"TEMP-A",color:"白"}, {alternateStyleNo:"temp-a",color:"白"},
    ])).not.toBeNull();
  });

  it("allows a repeated alias on its own row and preserves cross-color alias handling", () => {
    expect(duplicateSourcingLineMessage([
      {styleNo:"DX-01",alternateStyleNo:"dx-01",color:"黑"},
      {alternateStyleNo:"DX-01",color:"白"},
    ])).toBeNull();
  });

  it("preserves leading zeros and punctuation rather than guessing corrections", () => {
    expect(normalizeSourcingStyleNumber(" AB-001 ")).toBe("ab-001");
    expect(sourcingStyleNumbers([{styleNo:"AB-001",alternateStyleNo:"AB001"}])).toEqual(["ab-001","ab001"]);
    expect(duplicateSourcingLineMessage([{styleNo:"AB-001"}, {styleNo:"AB001"}, {styleNo:"AB-1"}])).toBeNull();
  });

  it("blocks the same formal number across colors at all three request boundaries", () => {
    const lineItems = [{styleNo:"DX-01",color:"黑",quantity:770}, {styleNo:"\t dx-01 \u00a0",color:"白",quantity:600}];
    const facts = {
      gender:"男装", styleName:"短裤", estimatedCutPieceSendDate:"2026-09-20", deliveryDate:"2026-10-10",
      lineItems, attachmentIds:["00000000-0000-4000-8000-000000000001"], confirmedDuplicateStyles:["DX-01"],
    };
    const message = "第1行与第2行正式款号重复，请核对后修改。";
    expect(duplicateSourcingLineMessage(lineItems)).toBe(message);
    for (const result of [
      CreateSourcingCaseSchema.safeParse({...facts, daxingUnitPrice:"12"}),
      CorrectSourcingCaseSchema.safeParse({...facts, expectedVersion:2, reason:"更正款号"}),
      ReviseSourcingStylesSchema.safeParse({expectedRevision:0, confirmedDuplicateStyles:facts.confirmedDuplicateStyles,
        lines:lineItems.map(({styleNo}, index)=>({position:index+1, styleNo, alternateStyleNo:null}))}),
    ]) {
      expect(result.error?.issues[0]?.message).toBe(message);
    }
    expect(ReviseSourcingStylesSchema.safeParse({expectedRevision:0, lines:[
      {position:1, styleNo:"DX-01", alternateStyleNo:null}, {position:2, styleNo:null, alternateStyleNo:"DX-01"},
    ]}).success).toBe(true);
  });
});
