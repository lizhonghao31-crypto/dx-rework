import { describe,expect,it } from "vitest";
import { DigitalOrderCreateSchema,DigitalPoInputSchema,digitalPoKey } from "@dx-rework/contracts/digital-production";
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
