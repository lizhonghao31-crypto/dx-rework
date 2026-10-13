import { describe, expect, it } from "vitest";
import { canChangeSourcingTransferDeliveryDate, RequestSourcingFactoryChangeSchema } from "@dx-rework/contracts";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";

const id="00000000-0000-4000-8000-000000000001";
const input={supplierId:id,unitPrice:"15.5",changeReason:"TEST-改交期",deliveryDate:"2026-10-30"};
describe("transfer delivery date authorization",()=>{
  it.each([
    [true,[],[],true],
    [false,["production_management"],["sourcing:decision:record"],true],
    [false,["production_management"],["sourcing:view"],false],
    [false,["owner_group"],["sourcing:owner:approve"],false],
    [false,["order_merchandiser"],["sourcing:factory_change:request"],false],
    [false,["system_admin"],["sourcing:decision:record"],false],
  ])("checks explicit role and capability: %s / %s",(isRoot,businessRoles,capabilities,allowed)=>{
    expect(canChangeSourcingTransferDeliveryDate({isRoot:isRoot as boolean,businessRoles:businessRoles as string[],capabilities:capabilities as string[]})).toBe(allowed);
  });
  it("accepts the existing request shape and real dates without allowing unrelated date fields",()=>{
    expect(RequestSourcingFactoryChangeSchema.safeParse(input).success).toBe(true);
    expect(RequestSourcingFactoryChangeSchema.safeParse({supplierId:id,unitPrice:"15.5",changeReason:"TEST-old"}).success).toBe(true);
    for(const deliveryDate of ["2026-02-30","2026-13-01","", "2026-1-2"])
      expect(RequestSourcingFactoryChangeSchema.safeParse({...input,deliveryDate}).success).toBe(false);
    expect(RequestSourcingFactoryChangeSchema.safeParse({...input,customerWarehouseDate:"2026-10-30"}).success).toBe(false);
  });
  it.each([
    ["owner_group","sourcing:owner:approve"],
    ["order_merchandiser","sourcing:factory_change:request"],
  ])("rejects forged date fields from %s before database access",async(role,capability)=>{
    const service=new SourcingService({} as never);
    await expect(service.requestFactoryChange({actorId:id,actorRoles:[role],authorizationCapability:capability,
      authorizationCapabilities:["sourcing:view",capability],requestId:"TEST-denied"},id,input,"TEST-key")).rejects.toMatchObject({statusCode:403});
  });
});
