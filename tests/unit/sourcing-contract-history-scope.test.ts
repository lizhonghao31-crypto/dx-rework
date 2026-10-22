import { describe, expect, it } from "vitest";
import { contractHistoryBaseline, contractHistoryBaselines } from "../../apps/api/src/sourcing/sourcing-contract-history-scope.js";
import { SourcingTransferContractReconciliation } from "../../apps/api/src/sourcing/sourcing-transfer-contract-reconciliation.js";
import type { Pool } from "pg";

describe("fixed three-order historical authorization", () => {
  const actor = {actorId:"test",actorRoles:["root_superuser"],authorizationCapability:"todo:routing_exception_manage",requestId:"test"};
  const repair = new SourcingTransferContractReconciliation({connect:()=>{throw new Error("unexpected database access");}} as unknown as Pool);
  it("keeps exactly three unique IDs and their approved document/version baselines", () => {
    expect(contractHistoryBaselines).toEqual([
      {caseId:"46983c93-bb0c-4a28-b23c-4531feb4ad41",documentId:"14cdb30d-d148-4cd7-a9ac-6b65be5f61d0",version:2,generatedAt:"2026-10-15T11:40:54+08:00"},
      {caseId:"cb942dbe-d6b2-43b2-9f48-3933566b7cf0",documentId:"1e4c3ec5-d2ec-4404-aa7f-fef33262ac3c",version:3,generatedAt:"2026-10-13T18:15:39+08:00"},
      {caseId:"edfb86e9-9206-419d-8faf-ca11cb7c88ac",documentId:"aff97855-53bc-4692-9c9b-b925fa80ebff",version:3,generatedAt:"2026-09-30T08:59:13+08:00"},
    ]);
    expect(contractHistoryBaseline("RO20547997")).toBeUndefined();
    expect(contractHistoryBaseline("00000000-0000-4000-8000-000000000001")).toBeUndefined();
  });
  it("rejects outside-scope, repeated and fourth orders before connecting", async () => {
    const outside="00000000-0000-4000-8000-000000000001";
    await expect(repair.preview(actor,[outside])).rejects.toMatchObject({statusCode:409});
    await expect(repair.preview(actor,[...contractHistoryBaselines.map(row=>row.caseId),outside])).rejects.toMatchObject({statusCode:409});
    await expect(repair.apply(actor,[{caseId:outside,documentId:outside,version:1,evidenceHash:"a".repeat(64)}],"test","test")).rejects.toMatchObject({statusCode:409});
    await expect(repair.preview(actor,[contractHistoryBaselines[0]!.caseId,contractHistoryBaselines[0]!.caseId])).rejects.toMatchObject({statusCode:409});
  });
  it("rejects unauthorized callers before reading or writing", async () => {
    await expect(repair.preview({...actor,actorRoles:["production_management"]})).rejects.toMatchObject({statusCode:403});
    await expect(repair.apply({...actor,actorRoles:["owner_group"]},[],"test","test")).rejects.toMatchObject({statusCode:403});
  });
});
