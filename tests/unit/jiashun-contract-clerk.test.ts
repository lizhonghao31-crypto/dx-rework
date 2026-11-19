import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import { SourcingContractReturnService } from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { canAccessSourcing } from "../../apps/web/src/platform-modules.js";
import type { AuthorizedUser } from "../../apps/web/src/auth.js";
import { JIASHUN_CASE_FILTER_SQL, JIASHUN_CLERK_ROLE, JIASHUN_CONTRACT_RETURN,
  JIASHUN_READ, JiashunContractClerkScope } from "../../apps/api/src/sourcing/jiashun-contract-clerk-scope.js";

const userId="00000000-0000-4000-8000-000000000011";
const caseId="00000000-0000-4000-8000-000000000022";
const documentId="00000000-0000-4000-8000-000000000033";
const oldDocumentId="00000000-0000-4000-8000-000000000044";
const clerk={actorId:userId,actorRoles:[JIASHUN_CLERK_ROLE],authorizationCapability:JIASHUN_READ,
  authorizationCapabilities:[JIASHUN_READ,JIASHUN_CONTRACT_RETURN,"tools:jiashun_contract_file"],requestId:"unit-clerk"};

type PoolMockQuery = (sql:string,params?:readonly unknown[])=>Promise<{rows:unknown[]}>;

const database=(overrides:Partial<Record<string,unknown>>={})=>{
  const query=vi.fn<PoolMockQuery>(async (sql)=>{
    if(sql.includes("FROM user_role_assignments assignment"))return {rows:[{role_code:JIASHUN_CLERK_ROLE}]};
    if(sql.includes("FROM role_capabilities"))return {rows:[{capability:JIASHUN_READ},{capability:JIASHUN_CONTRACT_RETURN},{capability:"tools:jiashun_contract_file"}]};
    if(sql.includes("SELECT EXISTS")&&sql.includes("sourcing_cases case_view"))return {rows:[{allowed:overrides.caseAllowed!==false}]};
    if(sql.includes("SELECT document.sourcing_contract_document_id")&&sql.includes("JOIN sourcing_approval_snapshots"))return {rows:[{sourcing_contract_document_id:documentId}]};
    if(sql.includes("sourcing_contract_document_id,status,"))return {rows:[{sourcing_contract_document_id:overrides.currentId??documentId,status:overrides.status??"ready",effective:overrides.effective??true}]};
    if(sql.includes("FROM sourcing_contract_return_attachments link"))return {rows:overrides.returnFiles??[]};
    if(sql.includes("FROM sourcing_contract_documents WHERE sourcing_contract_document_id"))return {rows:[{sourcing_case_id:caseId}]};
    return {rows:[{total_count:"0",total_order_quantity:"0",sourcing_case_id:null}]};
  });
  return {pool:{query} as unknown as Pool,query};
};

describe("嘉顺文员后端权限边界",()=>{
  it("A01-A03 仅三家已批准供应商ID进入订单筛选，且先于总数与分页",async()=>{
    const {pool,query}=database();
    const result=await new SourcingService(pool).listCases(clerk,"", "all",1);
    const sql=query.mock.calls.at(-1)?.[0]??"";
    expect(JIASHUN_CASE_FILTER_SQL).toContain("scoped_snapshot.supplier_id");
    expect(sql).toContain("AND ($8::boolean=false OR ");
    expect(sql.indexOf("AND ($8::boolean=false OR ")).toBeLessThan(sql.indexOf("SELECT count(*)::text AS total_count"));
    expect(query.mock.calls.at(-1)?.[1]?.[7]).toBe(true);
    expect(result).toMatchObject({items:[],totalCount:0,totalOrderQuantity:0});
  });

  it("A04 其它原角色仍使用其原有全部订单查询",async()=>{
    const {pool,query}=database();
    const actor={...clerk,actorRoles:["order_merchandiser"],authorizationCapability:"sourcing:view",authorizationCapabilities:["sourcing:view"]};
    await new SourcingService(pool).listCases(actor);
    expect(query.mock.calls.at(-1)?.[1]?.[7]).toBe(false);
  });

  it("A05-A06 非三厂订单直连403，历史合同按其原批准工厂独立核权",async()=>{
    const blocked=database({caseAllowed:false});
    await expect(new JiashunContractClerkScope(blocked.pool).assertCase(clerk,caseId))
      .rejects.toMatchObject({statusCode:403,code:"FORBIDDEN"});
    const allowed=database();
    await expect(new JiashunContractClerkScope(allowed.pool).assertDocument(clerk,caseId,oldDocumentId))
      .rejects.toMatchObject({statusCode:403});
    await expect(new JiashunContractClerkScope(allowed.pool).assertDocument(clerk,caseId,documentId))
      .resolves.toBeUndefined();
  });

  it("A07-A08 只有当前ready文档可回传，换版、未就绪和过期页面均拒绝",async()=>{
    await expect(new JiashunContractClerkScope(database({currentId:oldDocumentId}).pool)
      .assertCurrentDocument(clerk,caseId,documentId)).rejects.toMatchObject({statusCode:409});
    await expect(new JiashunContractClerkScope(database({status:"generating"}).pool)
      .assertCurrentDocument(clerk,caseId,documentId)).rejects.toMatchObject({statusCode:409});
    await expect(new JiashunContractClerkScope(database({effective:false}).pool)
      .assertCurrentDocument(clerk,caseId,documentId)).rejects.toMatchObject({statusCode:409});
    await expect(new JiashunContractClerkScope(database().pool)
      .assertCurrentDocument(clerk,caseId,documentId)).resolves.toBeUndefined();
  });

  it("A09-A11 历史非嘉顺PDF及回签附件不能产生下载授权",async()=>{
    const {pool}=database({returnFiles:[{sourcing_case_id:caseId,sourcing_contract_document_id:oldDocumentId}]});
    const scope=new JiashunContractClerkScope(pool);
    expect(await scope.canDownloadBoundAttachment(clerk,{attachmentId:oldDocumentId,entityType:"sourcing_contract_return",entityId:caseId,mimeType:"application/pdf"})).toBe(false);
    expect(await scope.canDownloadBoundAttachment(clerk,{attachmentId:oldDocumentId,entityType:"sourcing_contract_document",entityId:oldDocumentId,mimeType:"application/pdf"})).toBe(false);
    expect(await scope.canDownloadBoundAttachment(clerk,{attachmentId:oldDocumentId,entityType:"wage",entityId:caseId,mimeType:"application/pdf"})).toBe(false);
  });

  it("A12 撤销角色后，打开的页面也不能继续查询",async()=>{
    const {pool,query}=database();
    query.mockImplementation(async(sql:string)=>sql.includes("user_role_assignments assignment")?{rows:[]}:{rows:[]});
    await expect(new JiashunContractClerkScope(pool).assertCase(clerk,caseId))
      .rejects.toMatchObject({statusCode:403});
  });

  it("A13 重复幂等键也必须先核当前工厂与文档、不能先重放成功",async()=>{
    const statements:string[]=[];
    const client={query:vi.fn(async(sql:string)=>{statements.push(sql);return {rows:[]};}),release:vi.fn()};
    const pool={connect:vi.fn(async()=>client)} as unknown as Pool;
    const guard=vi.spyOn(JiashunContractClerkScope.prototype,"assertCurrentDocument")
      .mockImplementationOnce(async (_actor,_caseId,_documentId,client)=>{
        await client?.query("SELECT sourcing_case_id FROM sourcing_cases FOR UPDATE");
        throw new ApplicationError("FORBIDDEN","转厂后无权回传",403);
      });
    try{
      await expect(new SourcingContractReturnService(pool).submit({...clerk,authorizationCapability:JIASHUN_CONTRACT_RETURN},
        caseId,["00000000-0000-4000-8000-000000000055"],"same-request",documentId))
        .rejects.toMatchObject({statusCode:403});
      expect(statements.some(sql=>sql.includes("sourcing_contract_return_requests submission"))).toBe(false);
      expect(statements.some(sql=>sql.includes("FOR UPDATE"))).toBe(true);
      expect(statements).toContain("ROLLBACK");
    }finally{guard.mockRestore();}
  });

  it("A14 跨厂分析对文员403，其它角色旧行为不变",async()=>{
    const {pool}=database();
    await expect(new SourcingService(pool).analysis(clerk,{})).rejects.toMatchObject({statusCode:403});
  });

  it("A15 首页外发入口由专属角色放行，但不向普通无权账号开放",()=>{
    const asUser=(roles:string[],capabilities:string[]):AuthorizedUser=>({
      isRoot:false,businessRoles:roles,capabilities,
    } as AuthorizedUser);
    expect(canAccessSourcing(asUser([JIASHUN_CLERK_ROLE],[JIASHUN_READ]))).toBe(true);
    expect(canAccessSourcing(asUser([JIASHUN_CLERK_ROLE],[]))).toBe(false);
    expect(canAccessSourcing(asUser([JIASHUN_CLERK_ROLE,"order_merchandiser"],[JIASHUN_READ]))).toBe(false);
    expect(canAccessSourcing(asUser(["order_merchandiser"],["sourcing:view"]))).toBe(true);
  });

  it("A16 文员即使拥有曾经上传的未绑定文件，也不能申请下载授权",async()=>{
    const query=vi.fn(async()=>({rows:[{
      attachment_id:"00000000-0000-4000-8000-000000000099",object_key:"test-unbound",
      original_filename:"unrelated.pdf",mime_type:"application/pdf",size_bytes:"100",sha256:"a".repeat(64),
      uploaded_by:userId,entity_type:null,entity_id:null,status:"ready",created_at:new Date(),
    }]}));
    const service=new AttachmentService({query} as unknown as Pool,
      {} as ConstructorParameters<typeof AttachmentService>[1],{prefix:"test",ttlSeconds:120,maxUploadBytes:20*1024*1024});
    await expect(service.createDownloadIntent(clerk,"00000000-0000-4000-8000-000000000099"))
      .rejects.toMatchObject({statusCode:403});
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("A17 厂别只读接口不返回主档备注和银行资料缺项",async()=>{
    const {pool,query}=database();
    query.mockImplementation(async(sql:string)=>{
      if(sql.includes("FROM user_role_assignments assignment"))return {rows:[{role_code:JIASHUN_CLERK_ROLE}]};
      if(sql.includes("FROM role_capabilities"))return {rows:[{capability:JIASHUN_READ},
        {capability:JIASHUN_CONTRACT_RETURN},{capability:"tools:jiashun_contract_file"}]};
      return {rows:[{supplier_id:caseId,supplier_code:"FAC_601BEF926B41",supplier_name:"嘉顺七厂",
        supported_crafts:[],daily_capacity:100,notes:"不应公开的联系方式",
        contract_data_missing:["bankAccount","bankName"]}]};
    });
    const response=await new SourcingService(pool).listFactories(clerk);
    expect(response.items).toHaveLength(1);
    expect(response.items[0]).toMatchObject({notes:"",contractDataMissing:[]});
  });

  it("A18 单单派单状态可以只读，且文员永远不能获得派单操作标志",async()=>{
    const query=vi.fn(async(sql:string)=>sql.includes("FROM sourcing_cases source_case")
      ? {rows:[{sourcing_case_id:caseId,created_by:userId,sourcing_approval_snapshot_id:oldDocumentId,
        sourcing_contract_document_id:documentId,contract_status:"ready"}]}
      : {rows:[]});
    const scope=vi.spyOn(JiashunContractClerkScope.prototype,"assertCase").mockResolvedValueOnce(undefined);
    try {
      const result=await new SourcingProductionService({query} as unknown as Pool).state(clerk,caseId);
      expect(result).toEqual({item:null,canDispatch:false});
      expect(scope).toHaveBeenCalledWith(clerk,caseId);
    }finally{scope.mockRestore();}
  });
});
