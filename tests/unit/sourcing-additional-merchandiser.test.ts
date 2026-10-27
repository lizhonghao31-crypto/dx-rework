import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { SourcingContractReturnService } from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";

const creator="00000000-0000-4000-8000-000000000001";
const additional="00000000-0000-4000-8000-000000000002";
const other="00000000-0000-4000-8000-000000000003";
const caseId="00000000-0000-4000-8000-000000000100";

function actor(actorId:string):TrustedActorContext {
  return {actorId,actorRoles:["order_merchandiser"],authorizationCapability:"sourcing:view",
    authorizationCapabilities:["sourcing:view","sourcing:contract:record","supplier_contract_data:read"],requestId:"test"};
}

describe("additional merchandiser contract scope",()=>{
  it("allows either named merchandiser to return the first contract but not another merchandiser",async()=>{
    let returned=false;
    const query=vi.fn(async (sql:string)=>{
      if (sql.includes("sourcing_contract_return_clock_scope")) return {rows:[{native_order_id:null,scenario_id:null}]};
      if (sql.includes("business_module_owner_bindings")) return {rows:[{available:false}]};
      if (sql.includes("FROM sourcing_cases source_case")) return {rows:[{
        sourcing_case_id:caseId,created_by:creator,additional_merchandiser_user_id:additional,
        contract_return_monitor_enabled:true,contract_return_catchup:false,
        current_contract_accepts_upload:true,current_contract_document_id:null,return_cycle_id:null,
        contract_generated_at:null,contract_return_due_at:null,
        contract_returned_at:returned ? "2026-09-26T00:00:00.000Z" : null,
        contract_return_uploaded_by:null,contract_return_overdue_seconds:null,
        uploader_name:null,as_of:"2026-09-27T00:00:00.000Z",
      }]};
      return {rows:[]};
    });
    const service=new SourcingContractReturnService({query} as unknown as Pool);
    expect((await service.get(actor(creator),caseId)).canUpload).toBe(true);
    expect((await service.get(actor(additional),caseId)).canUpload).toBe(true);
    expect((await service.get(actor(other),caseId)).canUpload).toBe(false);
    returned=true;
    expect((await service.get(actor(creator),caseId)).canUpload).toBe(true);
    expect((await service.get(actor(additional),caseId)).canUpload).toBe(true);
  });
});
