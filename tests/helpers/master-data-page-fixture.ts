import {CreateBusinessPersonSchema,CreateSupplierSchema} from "@dx-rework/contracts";
import {businessAnchorFixture} from "./business-anchor-fixture.js";

/** New records through native commands in a newly owned marked TEST schema. */
export async function masterDataPageFixture(url:string){
 const f=await businessAnchorFixture(url),personIds:string[]=[],supplierIds:string[]=[];
 const master={...f.root,authorizationCapability:"master_data:manage",authorizationCapabilities:["master_data:manage","access:admin"]};
 try{
  for(let index=0;index<31;index++){
   const suffix=String(index+1).padStart(2,"0");
   personIds.push((await f.access.createPerson(master,CreateBusinessPersonSchema.parse({personType:"temporary",displayName:"TEST 目录人员 "+suffix,aliases:["TEST目录别名"+suffix],temporaryRemark:"TEST目录批次",temporaryPhoneNumber:"00000000000",temporaryIdentityNumber:"000000000000000000",reason:"TEST分页原生命令"}))).personId);
   supplierIds.push((await f.access.createSupplier(f.root,CreateSupplierSchema.parse({supplierCode:"TEST-DIRECTORY-"+suffix,supplierType:index%2?"fabric":"factory",supplierName:"TEST 目录供应商 "+suffix,active:index!==30,supportedCrafts:[index===30?"TEST最后页工艺":"TEST普通工艺"],...(index%2?{address:"TEST地址",contractEntityName:"TEST签约",partyBRepresentative:"TEST代表",payeeName:"TEST收款",bankAccount:"000000",bankName:"TEST银行"}:{}),changeReason:"TEST分页原生命令"}))).supplierId);
  }
  return {...f,personIds,supplierIds,master};
 }catch(error){await f.dispose();throw error;}
}
