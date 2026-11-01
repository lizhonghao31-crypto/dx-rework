import { describe, expect, it } from "vitest";
import { DigitalOrderCreateSchema, type DigitalOrderInput } from "@dx-rework/contracts/digital-production";
import { DevelopmentDocumentSchema, developmentPublishErrors } from "@dx-rework/contracts/digital-development";
import { developmentOrderInput, developmentQuantityError, developmentQuantityTotal, editableDevelopmentOrder, initialDevelopmentDocument, removeDevelopmentSize } from "../../apps/web/src/digital-development-editing.js";

const order = (): DigitalOrderInput => ({customerCode:"TEST",designStyleNo:"TEST-STYLE",temporaryStyleNo:"TEST-TEMP",productGroup:"男装",orderDate:"2026-10-10",contractDeliveryDate:null,lines:[{formalPoNo:"TEST-PO",poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:"黑",colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:"2026-11-10",sizes:[{size:"M",quantity:1}]}]});
describe("creation quantity buffers and development matrix", () => {
  it("keeps whole deletion empty, accepts replacement and parses pasted leading zeroes only on submission", () => {
    const draft=editableDevelopmentOrder(order());
    draft.lines[0]!.sizes[0]!.quantity="";
    expect(draft.lines[0]!.sizes[0]!.quantity).toBe("");
    expect(()=>developmentOrderInput(draft)).toThrow("至少填写一项正整数订购数量");
    draft.lines[0]!.sizes[0]!.quantity="100";
    expect(developmentOrderInput(draft).lines[0]!.sizes[0]!.quantity).toBe(100);
    draft.lines[0]!.sizes[0]!.quantity="0100";
    expect(developmentOrderInput(draft).lines[0]!.sizes[0]!.quantity).toBe(100);
    expect(draft.lines[0]!.sizes[0]!.quantity).toBe("0100");
    for(const value of ["-1","1.5","1e2"," 1","文字","10000001"]) {draft.lines[0]!.sizes[0]!.quantity=value;expect(()=>developmentOrderInput(draft)).toThrow("数量");}
  });
  it("totals blank and zero buffers as zero without treating invalid quantities as an order", () => {
    expect(developmentQuantityError("")).toBeNull();
    expect(developmentQuantityError("0")).toBeNull();
    expect(developmentQuantityTotal([{size:"S",quantity:""},{size:"M",quantity:"0"},{size:"36",quantity:"002"}])).toBe(2);
    for (const value of ["-1","0.5","S","1e2"]) {
      expect(developmentQuantityError(value)).not.toBeNull();
      expect(developmentQuantityTotal([{size:"S",quantity:value}])).toBeNull();
    }
  });
  it("omits un-ordered zero size cells while retaining the original positive PO and API limits", () => {
    const draft=editableDevelopmentOrder(order());
    draft.lines[0]!.sizes=[{size:"S",quantity:""},{size:"M",quantity:"0"},{size:"均码",quantity:"2"},{size:"36",quantity:"3"}];
    const parsed=DigitalOrderCreateSchema.parse(developmentOrderInput(draft));
    expect(parsed.lines[0]!.sizes).toEqual([{size:"均码",quantity:2},{size:"36",quantity:3}]);
    expect(draft.lines[0]!.sizes.map(size=>size.quantity)).toEqual(["","0","2","3"]);
    draft.lines[0]!.sizes=[{size:"S",quantity:"0"}];
    expect(()=>developmentOrderInput(draft)).toThrow("至少填写一项正整数订购数量");
    draft.lines[0]!.sizes=[{size:"S",quantity:"10000000"},{size:"M",quantity:"1"}];
    expect(DigitalOrderCreateSchema.safeParse(developmentOrderInput(draft)).success).toBe(false);
  });
  it("preserves two independent PO identities, colours, quantities and dates with an optional line temporary override", () => {
    const draft=editableDevelopmentOrder(order());
    draft.lines.push({...draft.lines[0]!,formalPoNo:"TEST-PO2",temporaryStyleNo:"TEST-OTHER",color:"白",customerWarehouseArrivalDate:"2026-11-20",sizes:[{size:"L",quantity:"250"}]});
    const parsed=DigitalOrderCreateSchema.parse(developmentOrderInput(draft));
    expect(parsed.lines.map(line=>[line.formalPoNo,line.temporaryStyleNo,line.color,line.customerWarehouseArrivalDate,line.sizes[0]!.quantity])).toEqual([["TEST-PO","TEST-TEMP","黑","2026-11-10",1],["TEST-PO2","TEST-OTHER","白","2026-11-20",250]]);
    expect(initialDevelopmentDocument().quantity).toBeNull();
  });
  it("removes exactly the chosen column without mutating the previous version or losing raw units and fractions", () => {
    const before=initialDevelopmentDocument("裤子");
    before.sizes=["M","L"];before.sizeQuantities=[null,null];before.unit="inch";before.measurements=[{name:"腰围",values:["2 1/2","123.456"]}];
    const after=removeDevelopmentSize(before,0);
    expect(after.sizes).toEqual(["L"]);expect(after.measurements[0]!.values).toEqual(["123.456"]);
    expect(before.measurements[0]!.values).toEqual(["2 1/2","123.456"]);
    expect(DevelopmentDocumentSchema.safeParse(after).success).toBe(true);
    expect(after.unit).toBe("inch");
    const empty=removeDevelopmentSize(after,0);
    expect(DevelopmentDocumentSchema.safeParse(empty).success).toBe(true);
    expect(developmentPublishErrors(empty)).not.toContain("至少填写一个尺码列，或先保存草稿");
  });
  it("permits incomplete size names in a draft, locates them at publication, and preserves legacy combined instructions", () => {
    const old=initialDevelopmentDocument();delete old.washingMethod;delete old.ironing;
    old.washingIroning="TEST原洗水整烫说明";old.sizes=["",""];old.sizeQuantities=[null,null];old.measurements=old.measurements.map(row=>({...row,values:["",""]}));
    expect(DevelopmentDocumentSchema.parse(old).washingIroning).toBe("TEST原洗水整烫说明");
    expect(developmentPublishErrors(old)).toContain("请填写尺码列名称，或删除不用的列");
    const next=DevelopmentDocumentSchema.parse({...old,washing:"免洗",ironing:"独立整烫",washingMethod:"保留待洗说明"});
    expect(next.ironing).toBe("独立整烫");expect(next.washingIroning).toBe(old.washingIroning);
  });
});
