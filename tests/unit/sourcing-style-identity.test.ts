import { describe, expect, it } from "vitest";
import { duplicateSourcingLineMessage, normalizeSourcingStyleNumber, sourcingStyleNumbers } from "../../packages/contracts/src/sourcing-style-identity.js";
import { CreateSourcingCaseSchema } from "../../packages/contracts/src/sourcing.js";

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

  it("permits different colors and a repeated alias within a single row", () => {
    expect(duplicateSourcingLineMessage([
      {styleNo:"DX-01",alternateStyleNo:"dx-01",color:"黑"},
      {styleNo:"DX-01",color:"白"},
    ])).toBeNull();
  });

  it("preserves leading zeros and punctuation rather than guessing corrections", () => {
    expect(normalizeSourcingStyleNumber(" AB-001 ")).toBe("ab-001");
    expect(sourcingStyleNumbers([{styleNo:"AB-001",alternateStyleNo:"AB001"}])).toEqual(["ab-001","ab001"]);
  });

  it("rejects duplicate line identities at the public create boundary", () => {
    const line={styleNo:"DX-01",color:"黑",quantity:1};
    expect(CreateSourcingCaseSchema.safeParse({
      gender:"男装",styleName:"短裤",estimatedCutPieceSendDate:"2026-09-20",deliveryDate:"2026-10-10",
      lineItems:[line,line],daxingUnitPrice:"12",attachmentIds:["00000000-0000-4000-8000-000000000001"],
    }).success).toBe(false);
  });
});
