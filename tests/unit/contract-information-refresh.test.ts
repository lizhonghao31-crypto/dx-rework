import { describe, expect, it } from "vitest";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  CONTRACT_TERM_LABELS, ContractTemplateContentSchema, RefreshContractInformationSchema,
  type ContractTemplateContent,
} from "@dx-rework/contracts";
import { missingSupplierContractFields, canRefreshContractInformation, SourcingContractManagementService } from "../../apps/api/src/sourcing/sourcing-contract-management-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const creator="00000000-0000-4000-8000-000000000001";
const actor = (role:string,capability:string,id=creator):TrustedActorContext=>({
  actorId:id,actorRoles:[role],authorizationCapability:capability,
  authorizationCapabilities:["sourcing:view",capability],requestId:"contract-test",
});
const template:ContractTemplateContent={templateName:"运费修正版",partyAName:"示例甲方",partyAAddress:"示例甲方地址",signingPlace:"广州",
  terms:{...Object.fromEntries(Object.keys(CONTRACT_TERM_LABELS).map(key=>[key,"示例条款"])) as ContractTemplateContent["terms"],
    processingResponsibility:"乙方负责{{工艺}}，甲方提供样板及面/辅料。",
    logistics:"甲方发货的物流费用由甲方支付，乙方回货的物流费用由乙方支付。",
  }};

describe("contract information refresh permissions",()=>{
  it.each([
    ["root_superuser","sourcing:contract:record",creator,false,true],
    ["root_superuser","sourcing:contract:record",creator,true,true],
    ["order_merchandiser","sourcing:contract:record",creator,false,true],
    ["order_merchandiser","sourcing:contract:record",creator,true,false],
    ["production_management","sourcing:decision:record",creator,false,true],
    ["production_management","sourcing:decision:record",creator,true,false],
    ["order_merchandiser","sourcing:contract:record","another-user",false,false],
    ["owner_group","sourcing:owner:approve",creator,false,false],
    ["factory_payables","sourcing:finance:reconcile",creator,false,false],
    ["system_admin","supplier_profile:write",creator,false,false],
    ["production_management","sourcing:view",creator,false,false],
  ])("enforces %s / %s / returned=%s",(role,capability,id,returned,allowed)=>{
    expect(canRefreshContractInformation(actor(role as string,capability as string,id as string),creator,returned as boolean)).toBe(allowed);
  });
  it("rejects template reads and previews by managers and merchandisers before accessing the database",async()=>{
    const service=new SourcingContractManagementService({} as never);
    for(const user of [actor("order_merchandiser","sourcing:contract:record"),actor("production_management","sourcing:decision:record")]){
      await expect(service.templates(user)).rejects.toMatchObject({code:"FORBIDDEN"});
      await expect(service.previewTemplate(user,template)).rejects.toMatchObject({code:"FORBIDDEN"});
      await expect(service.saveTemplate(user,{...template,expectedVersion:4},"template-save")).rejects.toMatchObject({code:"FORBIDDEN"});
    }
  });
  it("keeps order data out of editable templates and requires one dynamic process placeholder",()=>{
    expect(ContractTemplateContentSchema.safeParse({...template,unitPrice:"1"}).success).toBe(false);
    for(const text of ["没有动态工艺","{{工艺}}重复{{工艺}}"]){
      expect(ContractTemplateContentSchema.safeParse({...template,terms:{...template.terms,processingResponsibility:text}}).success).toBe(false);
    }
    expect(ContractTemplateContentSchema.safeParse(template).success).toBe(true);
    expect(RefreshContractInformationSchema.safeParse({sourcingContractDocumentId:creator,informationFingerprint:"a".repeat(64),supplierId:creator}).success).toBe(false);
  });
  it("renders editable V4 and future templates with corrected logistics, processes and existing table layout",async()=>{
    const service=new SourcingContractManagementService({} as never);
    const pdf=await service.previewTemplate(actor("root_superuser","sourcing:contract:record"),template);
    const doc=await getDocument({data:new Uint8Array(pdf),useSystemFonts:false}).promise;
    try{
      let text="";
      for(let page=1;page<=doc.numPages;page++){
        const data=await (await doc.getPage(page)).getTextContent();
        text+=data.items.flatMap(item=>"str" in item?[item.str]:[]).join("");
      }
      text=text.replace(/\s/g,"");
      expect(text).toContain("服装加工合同");
      expect(text).toContain("甲方发货的物流费用由甲方支付");
      expect(text).toContain("乙方回货的物流费用由乙方支付");
      expect(text).toContain("车缝、剪线、查货");
      expect(text).toContain("款式图片");
      expect(text).not.toContain("{{工艺}}");
    }finally{await doc.destroy?.();}
  });
});

it("identifies all missing contract profile fields without returning any supplier values",()=>{const missing=missingSupplierContractFields({supplierName:"TEST-private-name",supplierCode:"TEST-private-code",contractEntityName:"TEST-private-entity",address:"",partyBRepresentative:"TEST-private-person",payeeName:"",bankAccount:"",bankName:"TEST-private-bank"});expect(missing).toEqual(["地址","收款人","银行账号"]);expect(JSON.stringify(missing)).not.toContain("TEST-private");});
