import { describe, expect, it } from "vitest";
import { RequestSourcingFactoryChangeSchema, type SourcingCaseSummary } from "@dx-rework/contracts";
import { sourcingCurrentDisplay } from "../../apps/web/src/sourcing-current-display.js";

const id="00000000-0000-4000-8000-000000000001";
const original={styleNo:"OLD",gender:"女装",styleName:"原款",orderQuantity:20,
  estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",processes:["原工艺"],
  lineItems:[{position:1,styleNo:"OLD",alternateStyleNo:null,color:"红",quantity:20,externalUnitPrice:null,legacy:false}],
  decision:{supplierName:"原厂",totalAmount:"200",linePrices:[{position:1,quantity:20,unitPrice:"10",totalAmount:"200"}]} } as SourcingCaseSummary;
const contract={sourcingContractDocumentId:id,contractVersion:2,contractNumber:"人工编号",gender:"男装",styleName:"新款",
  partyBName:"本单乙方",estimatedCutPieceSendDate:"2026-10-02",deliveryDate:"2026-11-11",processes:["新工艺"],
  totalQuantity:33,totalAmount:"412.50",linesMatchOrder:true,
  lines:[{position:1,styleNo:"NEW",alternateStyleNo:"ALT",color:"紫",quantity:33,unitPrice:"12.50",totalAmount:"412.50",imageAttachmentId:id}]};

describe("current contract presentation without rewriting order or approval facts",()=>{
  it("maps current fields and amounts identically for both responsive layouts",()=>{
    const item={...original,contractDisplay:contract};const before=JSON.stringify(item);
    const view=sourcingCurrentDisplay(item);
    expect(view).toMatchObject({styleNo:"NEW",gender:"男装",styleName:"新款",supplierName:"本单乙方",quantity:33,
      totalAmount:"412.50",estimatedCutPieceSendDate:"2026-10-02",deliveryDate:"2026-11-11",processes:["新工艺"]});
    expect(view.lines[0]).toMatchObject({styleNo:"NEW",alternateStyleNo:"ALT",color:"紫",quantity:33,imageAttachmentId:id});
    expect(view.prices[0]).toMatchObject({unitPrice:"12.50",totalAmount:"412.50"});
    expect(JSON.stringify(item)).toBe(before);
  });
  it("retains original lines and prices when historical contract positions are ambiguous",()=>{
    const view=sourcingCurrentDisplay({...original,contractDisplay:{...contract,linesMatchOrder:false,
      lines:[contract.lines[0]!,contract.lines[0]!]}});
    expect(view.lines).toEqual(original.lineItems);expect(view.prices).toEqual([{position:1,unitPrice:"10",totalAmount:"200"}]);
  });
  it("retains business dates for legacy text and impossible dates, while old orders remain readable",()=>{
    for(const date of ["按约定交货","2026-02-30","0000-01-01",""]){
      const view=sourcingCurrentDisplay({...original,contractDisplay:{...contract,deliveryDate:date,estimatedCutPieceSendDate:date}});
      expect(view.deliveryDate).toBe(original.deliveryDate);expect(view.estimatedCutPieceSendDate).toBe(original.estimatedCutPieceSendDate);
    }
    expect(sourcingCurrentDisplay(original).lines).toBe(original.lineItems);
  });
  it("preserves legacy single-line and uniform transfer pricing without fabricating multi-line amounts",()=>{
    const legacy={...original,decision:{...original.decision!,unitPrice:"10",linePrices:[]}};
    expect(sourcingCurrentDisplay(legacy).prices).toEqual([{position:1,unitPrice:"10",totalAmount:"200"}]);
    const multi={...legacy,lineItems:[...legacy.lineItems,{...legacy.lineItems[0]!,position:2}],decision:{...legacy.decision,sourceType:"factory_change" as const}};
    expect(sourcingCurrentDisplay(multi).prices).toEqual([{position:1,unitPrice:"10",totalAmount:null},{position:2,unitPrice:"10",totalAmount:null}]);
  });
  it("keeps old transfer clients compatible and validates explicit craft changes",()=>{
    const input={supplierId:id,unitPrice:"9",changeReason:"转厂"};
    expect(RequestSourcingFactoryChangeSchema.safeParse(input).success).toBe(true);
    expect(RequestSourcingFactoryChangeSchema.safeParse({...input,craftIds:[id]}).success).toBe(true);
    for(const craftIds of [[],[id,id],Array(21).fill(id),["unknown"]])
      expect(RequestSourcingFactoryChangeSchema.safeParse({...input,craftIds}).success).toBe(false);
  });
});
