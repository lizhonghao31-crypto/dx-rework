import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import type { SourcingContractReturnService } from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import type { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import type { JiashunContractClerkScope } from "../../apps/api/src/sourcing/jiashun-contract-clerk-scope.js";
import type { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import type { ExportJobService } from "../../apps/api/src/tools/exports.js";
import { registerSourcingRoutes } from "../../apps/api/src/sourcing/sourcing-routes.js";
import { registerToolsRoutes } from "../../apps/api/src/tools/routes.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

const ids=[randomUUID(),randomUUID(),randomUUID()],otherId=randomUUID(),documentId=randomUUID(),userId=randomUUID();
const fileId=randomUUID();
const user={id:userId,displayName:"TEST-嘉顺文员",businessRoles:["jiashun_contract_clerk"],
  capabilities:["sourcing:jiashun:read","sourcing:jiashun:contract_return","tools:jiashun_contract_file"]};
const apps:ReturnType<typeof Fastify>[]=[];
afterEach(async()=>Promise.all(apps.splice(0).map(app=>app.close())));

const create=()=>{
  const app=Fastify();apps.push(app);
  const visible=new Set(ids);
  let currentDocument=documentId;
  const scope={
    assertActive:vi.fn(async()=>undefined),
    assertCase:vi.fn(async(_actor:unknown,id:string)=>{
      if(!visible.has(id))throw new ApplicationError("FORBIDDEN","不在嘉顺三厂范围",403);
    }),
    assertCurrentDocument:vi.fn(async(_actor:unknown,id:string,expected:string)=>{
      if(!visible.has(id))throw new ApplicationError("FORBIDDEN","订单已转出三厂",403);
      if(currentDocument!==expected)throw new ApplicationError("INVALID_STATE_TRANSITION","合同版本已变化",409);
    }),
  };
  const returnState={contractReturnMonitoring:true,contractReturnStatus:"pending",contractGeneratedAt:null,
    contractReturnDueAt:null,contractReturnedAt:null,contractReturnOverdueHours:0,uploadedByName:null,canUpload:true,
    uploadedFileCount:0,uploadedTotalBytes:0,currentContractReturned:false,currentContractDocumentId:documentId,
    signedContractDocumentId:null,signedContractVersion:null,signedContractNumber:null,attachments:[],history:[]};
  const service={
    listCases:vi.fn(async()=>({items:[],page:1,pageSize:15,totalCount:0,totalOrderQuantity:0,totalPages:1})),
    getCase:vi.fn(async()=>({sourcingCaseId:ids[0]})),
    analysis:vi.fn(async()=>({})),
    listFactories:vi.fn(async()=>({items:[]})),
  };
  const contractReturns={get:vi.fn(async()=>returnState),submit:vi.fn<(...args:Parameters<SourcingContractReturnService["submit"]>)=>Promise<typeof returnState>>(async()=>returnState)};
  const production={state:vi.fn(async()=>({item:null,canDispatch:false}))};
  registerSourcingRoutes(app,{authenticate:async()=>user,service:service as unknown as SourcingService,
    contractReturns:contractReturns as unknown as SourcingContractReturnService,
    production:production as unknown as SourcingProductionService,
    clerkScope:scope as unknown as JiashunContractClerkScope});
  const attachments={
    createUploadIntent:vi.fn(async()=>({attachmentId:fileId,objectKey:"TEST",uploadMethod:"POST",uploadUrl:"https://example.test/upload",
      uploadFields:{},expiresAt:"2026-11-19T00:00:00.000Z"})),
    clerkUploadContext:vi.fn(async()=>({sourcingCaseId:ids[0],documentId})),
    finalize:vi.fn(async()=>({attachmentId:fileId,status:"ready"})),
    createDownloadIntent:vi.fn(async()=>({downloadUrl:"https://example.test/download",expiresAt:"2026-11-19T00:00:00.000Z"})),
  };
  registerToolsRoutes(app,{authenticate:async()=>user,attachments:attachments as unknown as AttachmentService,
    exports:{} as ExportJobService,clerkScope:scope as unknown as JiashunContractClerkScope,
    canDownloadBoundAttachment:async()=>false});
  return {app,scope,visible,setCurrentDocument:(id:string)=>{currentDocument=id;},contractReturns,attachments,service,production};
};

describe("嘉顺专职文员HTTP读写白名单（合成身份，不触及真人）",()=>{
  it("A01-A03 三个厂对应订单均能打开并调用专属合同回传",async()=>{
    const {app,contractReturns,production}=create();
    for(const id of ids){
      const dispatch=await app.inject({url:`/sourcing/cases/${id}/dispatch`});
      expect(dispatch.statusCode).toBe(200);
      expect(dispatch.json()).toMatchObject({item:null,canDispatch:false});
      const result=await app.inject({method:"POST",url:`/sourcing/cases/${id}/contract-return`,
        headers:{"idempotency-key":"test-"+id},payload:{attachmentIds:[fileId],expectedContractDocumentId:documentId}});
      expect(result.statusCode).toBe(200);
    }
    expect(contractReturns.submit).toHaveBeenCalledTimes(3);
    expect(production.state).toHaveBeenCalledTimes(3);
    for(const call of contractReturns.submit.mock.calls)expect(call[0]).toMatchObject({
      authorizationCapability:"sourcing:jiashun:contract_return",
      actorRoles:["jiashun_contract_clerk"],
    });
  });

  it("A04-A06 第四厂详情、合同回传和跨厂分析直连403，列表可读",async()=>{
    const {app,contractReturns,service}=create();
    expect((await app.inject({url:"/sourcing/cases?page=1"})).statusCode).toBe(200);
    expect((await app.inject({url:`/sourcing/cases/${otherId}`})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:`/sourcing/cases/${otherId}/contract-return`,
      headers:{"idempotency-key":"test-else"},payload:{attachmentIds:[fileId],expectedContractDocumentId:documentId}})).statusCode).toBe(403);
    expect((await app.inject({url:"/sourcing/analysis"})).statusCode).toBe(403);
    expect(contractReturns.submit).not.toHaveBeenCalled();
    expect(service.analysis).not.toHaveBeenCalled();
  });

  it("A07-A09 转厂后的旧页面即使保留角色与幂等键也不得回传",async()=>{
    const {app,visible,contractReturns}=create();
    visible.delete(ids[0]!);
    const result=await app.inject({method:"POST",url:`/sourcing/cases/${ids[0]}/contract-return`,
      headers:{"idempotency-key":"same-key"},payload:{attachmentIds:[fileId],expectedContractDocumentId:documentId}});
    expect(result.statusCode).toBe(403);
    expect(contractReturns.submit).not.toHaveBeenCalled();
  });

  it("A10-A11 合同版本更替后旧的文件准备/确认请求均409",async()=>{
    const {app,scope,setCurrentDocument,attachments}=create();
    setCurrentDocument(randomUUID());
    const result=await app.inject({method:"POST",url:"/tools/attachments/upload-intents",payload:{
      filename:"TEST-signed.pdf",mimeType:"application/pdf",sizeBytes:512,sha256:"a".repeat(64),
      sourcingCaseId:ids[0],expectedContractDocumentId:documentId,
    }});
    expect(result.statusCode).toBe(409);
    expect(attachments.createUploadIntent).not.toHaveBeenCalled();
    expect(scope.assertCurrentDocument).toHaveBeenCalled();
  });

  it("A12 独立上传能力必须携带订单与合同，不能暂存其它用途的文件",async()=>{
    const {app,attachments}=create();
    const base={filename:"TEST-signed.pdf",mimeType:"application/pdf",sizeBytes:512,sha256:"a".repeat(64)};
    expect((await app.inject({method:"POST",url:"/tools/attachments/upload-intents",payload:base})).statusCode).toBe(400);
    expect((await app.inject({method:"POST",url:"/tools/attachments/upload-intents",payload:{...base,
      mimeType:"image/webp",sourcingCaseId:ids[0],expectedContractDocumentId:documentId}})).statusCode).toBe(400);
    expect(attachments.createUploadIntent).not.toHaveBeenCalled();
    const success=await app.inject({method:"POST",url:"/tools/attachments/upload-intents",payload:{...base,
      sourcingCaseId:ids[0],expectedContractDocumentId:documentId}});
    expect(success.statusCode).toBe(201);
    expect(attachments.createUploadIntent).toHaveBeenCalledWith(expect.objectContaining({authorizationCapability:"tools:jiashun_contract_file"}),
      base,{sourcingCaseId:ids[0],documentId});
  });

  it("A13-A14 不得生成合同、创建订单或导出",async()=>{
    const {app}=create();
    expect((await app.inject({method:"POST",url:`/sourcing/cases/${ids[0]}/return-to-merchandiser`,payload:{}})).statusCode).toBe(403);
    expect((await app.inject({url:"/sourcing/merchandisers"})).statusCode).toBe(403);
    expect((await app.inject({method:"POST",url:"/tools/exports",payload:{}})).statusCode).toBe(403);
  });
});
