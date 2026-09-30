import { describe, expect, it, vi } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { ContractContentSchema, SaveContractContentSchema, type ContractContent } from "@dx-rework/contracts";
import { canEditContractContent, SourcingContractContentService } from "../../apps/api/src/sourcing/sourcing-contract-content.js";
import { renderSourcingContractPdf } from "../../apps/api/src/sourcing/sourcing-contract-pdf.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const actor=(role:string):TrustedActorContext=>({actorId:"00000000-0000-4000-8000-000000000001",actorRoles:[role],authorizationCapability:"sourcing:contract:record",requestId:"edit-test"});
const content:ContractContent={contractTitle:"人工合同标题",partyARepresentative:"人工甲方代表",partyASigningDate:"2026-10-01",partyBSigningDate:"2026-10-02",contractNumber:"人工合同编号",contractDate:"2026-10-01",partyAName:"人工甲方",partyAAddress:"人工甲方地址",partyBName:"人工乙方",partyBAddress:"人工乙方地址",
  partyBRepresentative:"人工代表",payeeName:"人工收款人",bankAccount:"人工账号",bankName:"人工开户行",signingPlace:"人工地点",gender:"男装",styleName:"人工款式",
  estimatedCutPieceSendDate:"2026-10-05",deliveryDate:"2026-10-30",processes:["人工工艺"],
  lines:[{position:1,styleNo:"人工款号",alternateStyleNo:"人工代用款号",color:"紫色",quantity:22,unitPrice:"12.3456",totalAmount:"271.60"}],totalQuantity:22,totalAmount:"271.60",
  terms:{processingResponsibility:"双方另行约定加工责任。",qualityRequirements:"人工质量要求",delayPenalty:"人工延期约定",logistics:"人工运输约定",reasonableLoss:"人工损耗约定",
    defectRate:"人工次品约定",payment:"人工付款约定",effectiveness:"人工生效约定",validity:"人工有效期"}};
describe("Root contract content",()=>{
  it.each(["order_merchandiser","production_management","owner_group","system_admin","factory_payables"])("denies %s before accessing data",async role=>{
    const service=new SourcingContractContentService({} as never,{} as never);
    expect(canEditContractContent(actor(role),false)).toBe(false);
    await expect(service.get(actor(role),"case")).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(service.save(actor(role),"case",{sourcingContractDocumentId:actor(role).actorId,informationFingerprint:"a".repeat(64),content},"key")).rejects.toMatchObject({code:"FORBIDDEN"});
    await expect(service.preview(actor(role),"case",{sourcingContractDocumentId:actor(role).actorId,informationFingerprint:"a".repeat(64),content})).rejects.toMatchObject({code:"FORBIDDEN"});
  });
  it("allows Root only before an actual finance reconciliation",async()=>{
    expect(canEditContractContent(actor("root_superuser"),false)).toBe(true);
    expect(canEditContractContent(actor("root_superuser"),true)).toBe(false);
    const query=vi.fn(async()=>({rows:[{reconciled:true,status:"ready"}]}));
    const service=new SourcingContractContentService({query} as never,{} as never);
    await expect(service.get(actor("root_superuser"),"case")).rejects.toMatchObject({code:"FORBIDDEN",statusCode:403});
    expect(query.mock.calls).toHaveLength(1);
  });
  it("accepts contract-only edits and rejects injected approval/source fields",()=>{
    expect(ContractContentSchema.safeParse(content).success).toBe(true);
    expect(ContractContentSchema.safeParse({...content,supplierId:actor("root_superuser").actorId}).success).toBe(false);
    expect(ContractContentSchema.safeParse({...content,totalAmount:"NaN"}).success).toBe(false);
  });
  it("requires a real delivery date for edits that synchronize the order",()=>{
    const input={sourcingContractDocumentId:actor("root_superuser").actorId,informationFingerprint:"a".repeat(64),content};
    expect(SaveContractContentSchema.safeParse(input).success).toBe(true);
    for(const deliveryDate of ["", "0000-01-01", "2026-02-30", "2026-13-01", "收到后交货"])
      expect(SaveContractContentSchema.safeParse({...input,content:{...content,deliveryDate}}).success).toBe(false);
    // Existing PDFs can still render historical free-text fields.
    expect(ContractContentSchema.safeParse({...content,deliveryDate:"历史交期另议"}).success).toBe(true);
  });
  it("renders manually edited facts and complete responsibility clauses without appending stale processes",async()=>{
    const pdf=await renderSourcingContractPdf({...content,templateVersion:4});
    const document=await getDocument({data:new Uint8Array(pdf),useSystemFonts:false}).promise;
    try {
      let text="";for(let page=1;page<=document.numPages;page++)text+=(await (await document.getPage(page)).getTextContent()).items.flatMap(item=>"str" in item?[item.str]:[]).join("");
      text=text.replace(/\s/g,"");
      for(const expected of ["人工合同标题","人工甲方代表","人工合同编号","人工甲方","人工乙方","人工款号","人工代用款号","紫色","271.6","双方另行约定加工责任。","人工付款约定"])expect(text).toContain(expected);
      expect(text).not.toContain("undefined");expect(text).not.toContain("{{工艺}}");
    }finally{await document.destroy?.();}
  });
  it("keeps arbitrary date text and repeated process placeholders without corrupting or truncating the PDF",async()=>{
    const pdf=await renderSourcingContractPdf({...content,contractDate:"2026年10月1日",templateVersion:4,
      terms:{...content.terms,processingResponsibility:"负责{{工艺}}；复核{{工艺}}；完整末尾约定。"}});
    expect(pdf.toString("latin1")).not.toContain("NaN");
    const task=getDocument({data:new Uint8Array(pdf),useSystemFonts:false});
    const document=await task.promise;
    try {
      let text="";for(let page=1;page<=document.numPages;page++)text+=(await (await document.getPage(page)).getTextContent()).items.flatMap(item=>"str" in item?[item.str]:[]).join("");
      expect(text.replace(/\s/g,"")).toContain("负责人工工艺；复核人工工艺；完整末尾约定。");
      expect(text.replace(/\s/g,"")).toContain("2026年10月1日");
    } finally {await task.destroy();}
  });

});
