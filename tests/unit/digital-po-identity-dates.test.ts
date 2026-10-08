import { describe,expect,it } from "vitest";
import { DigitalOrderCreateSchema,DigitalPoInputSchema,digitalPoKey } from "@dx-rework/contracts/digital-production";
import { SourcingCaseLineInputSchema } from "@dx-rework/contracts";
import { validateFactoryInputs } from "../../apps/api/src/production-platform/po-factory-date-adapter.js";
const line = {color:"黑",sizes:[{size:"M",quantity:10}]};
const order = {customerCode:"PD",productGroup:"男装",designStyleNo:"TEST-PO",orderDate:"2026-10-08"};
describe("one formal PO and explicit customer promise contract",()=>{
  it("accepts the canonical input and consistent old aliases but refuses conflicting independent values",()=>{
    expect(DigitalPoInputSchema.parse({...line,formalPoNo:"  Po-1 "}).formalPoNo).toBe("Po-1");
    expect(DigitalPoInputSchema.safeParse({...line,formalPoNo:"Po-1",poNumber:"po-1",formalStyleNo:"PO-1"}).success).toBe(true);
    expect(DigitalPoInputSchema.safeParse({...line,poNumber:"PO-1",formalStyleNo:"STYLE-2"}).success).toBe(false);
    expect(digitalPoKey(" ÄA ")).toBe("Äa");
  });
  it("rejects a duplicate nonempty PO within its mother and keeps valid temporary or different PO identities",()=>{
    expect(DigitalOrderCreateSchema.safeParse({...order,lines:[{...line,formalPoNo:"PO-1"},{...line,color:"白",poNumber:" po-1 "}]}).success).toBe(false);
    expect(DigitalOrderCreateSchema.safeParse({...order,lines:[{...line,formalPoNo:null,temporaryStyleNo:"TMP-1"},{...line,color:"白",formalPoNo:null,temporaryStyleNo:"TMP-1"}]}).success).toBe(true);
    expect(DigitalOrderCreateSchema.safeParse({...order,lines:[{...line,formalPoNo:"PO-1"},{...line,color:"白",formalPoNo:"PO-2"}]}).success).toBe(true);
  });
  it("does not inject new optional fields into legacy idempotency payloads or accept a factory date during creation",()=>{
    const legacy=DigitalPoInputSchema.parse(line);
    expect(legacy).not.toHaveProperty("formalPoNo");expect(legacy).not.toHaveProperty("customerWarehouseArrivalDate");
    expect(DigitalPoInputSchema.safeParse({...line,factoryDeliveryDate:"2026-12-01"}).success).toBe(false);
    expect(DigitalPoInputSchema.safeParse({...line,deliveryDate:"2026-12-01",customerWarehouseArrivalDate:"2026-12-02"}).success).toBe(false);
  });
});
describe("digital sourcing stable identity with indistinguishable PO attributes",()=>{
  it("requires exact IDs even when alternate number, color and quantity cannot distinguish rows, while legacy line input stays compatible",()=>{
    const ids=["d7b33999-260c-420e-bfab-ff610624144a","398c8b0d-e825-4d70-8f0d-0dd728176ad0"];
    const rows=ids.map((line_id,index)=>({line_id,position:index+1,color:"黑",quantity:10,customer:"2026-11-20"}));
    const legacy={styleNo:"PO-A",alternateStyleNo:"SHARED-TEMP",color:"黑",quantity:10};
    expect(SourcingCaseLineInputSchema.parse(legacy)).not.toHaveProperty("lineId");
    const input={estimatedCutPieceSendDate:"2026-10-20",lineItems:ids.map((lineId,index)=>({...legacy,lineId,styleNo:index===0?"PO-A":"PO-B",factoryDeliveryDate:index===0?"2026-11-05":"2026-11-10"}))};
    expect(()=>validateFactoryInputs(rows,input,true)).not.toThrow();
    expect(()=>validateFactoryInputs(rows,{...input,lineItems:input.lineItems.map(row=>({...row,lineId:undefined}))},true)).toThrow("PO 身份");
    expect(()=>validateFactoryInputs(rows,{...input,lineItems:input.lineItems.map((row,index)=>({...row,lineId:ids[1-index]}))},true)).toThrow("PO 身份");
  });
});
