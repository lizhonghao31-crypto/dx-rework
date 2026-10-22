import Fastify from "fastify";
import {describe,it,expect,vi} from "vitest";
import {registerSourcingRoutes} from "../../apps/api/src/sourcing/sourcing-routes.js";
import type {SourcingService} from "../../apps/api/src/sourcing/sourcing-service.js";
import type {RootAuthority} from "../../apps/api/src/access/root-authority.js";

describe("price reapplication HTTP authority and strict fields",()=>{
  const caseId="00000000-0000-4000-8000-000000000010",docId="00000000-0000-4000-8000-000000000011";
  const input={unitPrice:"16.1234",changeReason:"TEST-price",expectedDecisionId:caseId,expectedContractDocumentId:docId};
  it("allows production and existing Root, denies owner/merchandiser and rejects non-price payloads",async()=>{
    const create=vi.fn(async()=>({value:{ok:true},reused:false})),review=vi.fn(async()=>({value:{ok:true},reused:false}));
    const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode??500).send({error:error.message}));
    registerSourcingRoutes(app,{service:{requestPriceReapplication:create,decidePriceReapplication:review} as unknown as SourcingService,
      root:{isRootUser:async(id:string)=>id==="root"} as unknown as RootAuthority,
      authenticate:async token=>{if(!token)throw Object.assign(new Error("unauthorized"),{statusCode:401});
        const role=token==="manager"?"production_management":token==="owner"?"owner_group":"order_merchandiser";
        return {id:token,displayName:"TEST",businessRoles:token==="root"?[]:[role],capabilities:token==="root"?[]:["sourcing:view","sourcing:decision:record","sourcing:owner:approve"]};}});
    await app.ready();
    try {
      const url=`/sourcing/cases/${caseId}/price-reapplications`,headers=(role:string)=>({cookie:`dx_rework_session=${role}`,'idempotency-key':"TEST-key"});
      expect((await app.inject({method:"POST",url,payload:input})).statusCode).toBe(401);
      for(const role of ["owner","merchandiser"])expect((await app.inject({method:"POST",url,headers:headers(role),payload:input})).statusCode).toBe(403);
      for(const field of ["supplierId","deliveryDate","estimatedCutPieceSendDate","quantity","craftIds"])expect((await app.inject({method:"POST",url,headers:headers("manager"),payload:{...input,[field]:"tampered"}})).statusCode).toBe(400);
      expect(create).not.toHaveBeenCalled();
      for(const role of ["manager","root"])expect((await app.inject({method:"POST",url,headers:headers(role),payload:input})).statusCode).toBe(201);
      expect(create.mock.calls[1]?.[0]).toMatchObject({actorRoles:expect.arrayContaining(["root_superuser"]),authorizationCapability:"sourcing:decision:record"});
      const reviewUrl=url+`/${docId}/decision`,body={decision:"approved",verificationReason:"TEST-approved"};
      expect((await app.inject({method:"POST",url:reviewUrl,headers:headers("manager"),payload:body})).statusCode).toBe(403);
      expect((await app.inject({method:"POST",url:reviewUrl,headers:headers("owner"),payload:body})).statusCode).toBe(201);
      expect(review).toHaveBeenCalledTimes(1);
    }finally{await app.close();}
  });
});
