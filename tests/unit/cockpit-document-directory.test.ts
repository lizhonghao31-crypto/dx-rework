import {expect,it} from "vitest";
import {JOURNEY_STAGES,JourneyReturnContextSchema,journeyReturnUrl,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {COCKPIT_DOCUMENT_CATEGORIES,loadCockpitDocumentCategory,loadCockpitDocumentEntry,type CockpitDocumentReader} from "../../apps/web/src/cockpit-documents-model.js";
import {cockpitContext,cockpitQuery} from "../../apps/web/src/digital-journey-cockpit-model.js";
const sid="00000000-0000-4000-8000-000000000001",oid="00000000-0000-4000-8000-000000000002",caseId="00000000-0000-4000-8000-000000000003",roundId="00000000-0000-4000-8000-000000000004";
const order:OrderJourney={id:sid,sourceId:sid,orderId:oid,designStyleNo:"TEST-DOC",temporaryStyleNo:null,customer:"TEST",category:null,designer:null,styleName:null,merchandisers:[],orderNumbers:[],createdAt:"2026-10-19T00:00:00Z",deliveryDate:null,selectedRound:2,adoptedRound:1,sourceVersion:3,instructionVersion:7,lines:[],links:[{domain:"sourcing",id:caseId,url:`/ui/sourcing/orders/${caseId}`,mode:"read",version:99,lineId:null}],stages:JOURNEY_STAGES.map(stage=>({...stage,state:"uncreated",nodes:[]})),progress:{development:null,bulk:null},hitReasons:[]};
const signal=new AbortController().signal;
it("keeps the approved ten production priorities plus every original source category and preserves directory context without sending it to list queries",()=>{
 expect(COCKPIT_DOCUMENT_CATEGORIES.slice(0,10).map(item=>item.key)).toEqual(['instruction','qc_progress','technical','preparation','cutting','factory','receiving','packing','contract','budget']);
 for(const key of ['development','pattern','misc','order','budget','instruction','contract','preparation','cutting','factory','receiving'])expect(COCKPIT_DOCUMENT_CATEGORIES.some(c=>c.key===key)).toBe(true);
 expect(new Set(COCKPIT_DOCUMENT_CATEGORIES.map(c=>c.key)).size).toBe(COCKPIT_DOCUMENT_CATEGORIES.length);
 const context=JourneyReturnContextSchema.parse({selected:sid,round:2,documentOpen:"contract|contract:doc1/return:2"});expect(cockpitContext(journeyReturnUrl(context).split("?")[1]!).documentOpen).toBe(context.documentOpen);expect(cockpitQuery(context)).not.toContain("documentOpen");
});
it("retains the real initial development document after revisions and reads only its original attachments",async()=>{
 const requested:string[]=[],read:CockpitDocumentReader=async path=>{requested.push(path);if(path.endsWith("/rounds"))return {rounds:[{roundNumber:2},{roundNumber:3}]};if(path.endsWith("/execution"))return {tasks:[],facts:[],routeFacts:[]};return path.endsWith("?round=1")?{sourceId:sid,roundNumber:1,version:1,document:{files:[{kind:"款图",attachmentId:"INITIAL-IMAGE"}]}}:{sourceId:sid,roundNumber:3,version:5,document:{files:[{kind:"款图",attachmentId:"LATEST-IMAGE"}]}};};
 const directory=await loadCockpitDocumentCategory(order,"development",read,signal);expect(directory.entries.map(entry=>entry.load?.version)).toEqual([3,2,1]);expect(requested.some(path=>path.includes("?round="))).toBe(false);
 const initial=await loadCockpitDocumentEntry(directory.entries[2]!,read,signal);expect(requested).toContain(`digital-production/sources/${sid}/development?round=1`);expect(initial.files?.map(file=>file.id)).toEqual(["INITIAL-IMAGE"]);expect(JSON.stringify(initial)).not.toContain("LATEST-IMAGE");
});
it("does not invent an initial-round link when development is absent or denied",async()=>{
 const absent=await loadCockpitDocumentCategory(order,"development",async path=>path.endsWith("/rounds")?{rounds:[]}:{sourceId:sid,version:0,roundNumber:1,document:null},signal);expect(absent).toMatchObject({state:"missing",entries:[]});
 const denied=Object.assign(new Error("development denied"),{status:403});await expect(loadCockpitDocumentCategory(order,"development",async()=>{throw denied;},signal)).rejects.toBe(denied);
});
it("binds two return revisions per contract document, independently of decision and PDF version numbers",async()=>{
 const read:CockpitDocumentReader=async()=>({contracts:[{kind:"contract",entryId:"doc-A",version:4,pdfAttachmentId:"pdf-A",pdfFilename:"原合同A.pdf",pdfStatus:"ready"},{kind:"contract",entryId:"doc-B",version:7,pdfAttachmentId:"pdf-B",pdfFilename:"原合同B.pdf",pdfStatus:"ready"}],versions:[1,2,3,4].map((revision,index)=>({revision,signedContractDocumentId:index<2?"doc-A":"doc-B",signedContractVersion:index<2?4:7,submittedAt:"2026-10-18T00:00:00Z",uploadedByName:"TEST签回人",attachments:[{attachmentId:`file-${revision}`,filename:`原合同回签_${revision}.pdf`}]}))});
 const data=await loadCockpitDocumentCategory(order,"contract",read,signal);expect(data.entries.map(entry=>[entry.id,entry.children?.map(child=>child.id)])).toEqual([["doc-A",["return:1","return:2"]],["doc-B",["return:3","return:4"]]]);expect(data.entries[0]?.files?.[0]?.path).toContain("pdf-A");expect(data.entries[1]?.files?.[0]?.path).toContain("pdf-B");expect(JSON.stringify(data)).not.toContain("99");
});
it("loads historical instruction versions on demand and refuses a latest-version fallback",async()=>{
 const requests:string[]=[],read:CockpitDocumentReader=async path=>{requests.push(path);return path.includes("?version=2")?{order:{productionOrderId:oid},version:2,sourceRound:1,document:{images:[{attachmentId:"OLD-PHOTO",kind:"款图"}]}}:{order:{productionOrderId:oid},version:7,versions:[7,2],document:{images:[{attachmentId:"LATEST-PHOTO",kind:"款图"}]}};};
 const data=await loadCockpitDocumentCategory(order,"instruction",read,signal);expect(requests).toHaveLength(1);const old=await loadCockpitDocumentEntry(data.entries[1]!,read,signal);expect(requests.at(-1)).toContain("version=2");expect(old.files?.[0]?.id).toBe("OLD-PHOTO");expect(JSON.stringify(old)).not.toContain("LATEST-PHOTO");await expect(loadCockpitDocumentEntry(data.entries[1]!,async()=>({order:{productionOrderId:oid},version:7,document:{}}),signal)).rejects.toThrow("所选历史版本");
});
it("does not turn denied budget metadata into missing or expose a directory entry",async()=>{
 const error=Object.assign(new Error("budget denied"),{status:403});await expect(loadCockpitDocumentCategory(order,"budget",async()=>{throw error;},signal)).rejects.toBe(error);
 expect((await loadCockpitDocumentCategory({...order,orderId:null},"budget",async()=>{throw Error("must not fetch");},signal)).state).toBe("not_applicable");
});
it("retains original UUID pattern rounds and disables retired materials",async()=>{
 const requests:string[]=[],read:CockpitDocumentReader=async path=>{requests.push(path);return path.startsWith("pattern-room/related")?{items:[{orderId:"pattern-1",kind:"pattern",orderNo:"TEST-P",rounds:[{roundId,roundIndex:2,roundType:"rework"}]}],nextPage:null}:{orderId:"pattern-1",rounds:[{roundId}],attachments:[{attachmentId:"retired",roundId,filename:"停用原件.pdf",active:false},{attachmentId:"other",roundId:"another-round",filename:"别轮.pdf",active:true}]};};
 const directory=await loadCockpitDocumentCategory(order,"pattern",read,signal),entry=directory.entries[0]!.children![0]!;expect(entry.url).toContain(roundId);const loaded=await loadCockpitDocumentEntry(entry,read,signal);expect(requests[1]).toContain(`round=${roundId}`);expect(loaded.files).toHaveLength(1);expect(loaded.files?.[0]).toMatchObject({id:"retired",path:null,note:"原件已停用"});
});
it("keeps receipt identities, all packing revisions and retired original images separate",async()=>{
 const entry={id:"batch-1",label:"TEST批次",load:{kind:"receiving",path:"receiving/batches/batch-1/document-history",id:"batch-1"}};
 const data=await loadCockpitDocumentEntry(entry,async()=>({batchIds:["batch-1"],files:[{id:"old",entityId:"batch-1",filename:"原送货单.jpg",status:"ready",retiredAt:"2026-10-18T00:00:00Z"}],receipts:[{receiptId:"receipt-1",actualQuantity:10,defectiveQuantity:1}],corrections:[{id:"correction-1",receiptId:"receipt-1",actualQuantity:9,defectiveQuantity:1}],packing:[{id:"packing-v1",quantity:8},{id:"packing-v2",quantity:9}],resolutions:[]}),signal);
 expect(data.files?.[0]?.path).toBeNull();expect(data.children?.map(child=>child.id)).toEqual(["receipt-1","packing-v1","packing-v2"]);expect(data.children?.[0]?.children?.[0]?.id).toBe("correction-1");
});

it("keeps an incomplete reader response distinct from an uncreated document",async()=>{await expect(loadCockpitDocumentCategory(order,"instruction",async()=>({}),signal)).rejects.toThrow("资料返回不完整");});
