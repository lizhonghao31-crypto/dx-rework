// @vitest-environment jsdom
import {act,createElement} from "react";
import {createRoot,type Root} from "react-dom/client";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {SourcingCaseSummarySchema,type SourcingCaseSummary} from "@dx-rework/contracts";
import {readSourcingDetail,useSourcingDetailRead,type SourcingDetailRequest} from "../../apps/web/src/sourcing-detail-read.js";
import {useSourcingDetailPrices} from "../../apps/web/src/sourcing-detail-prices.js";
import {useSourcingDetailSubmission} from "../../apps/web/src/sourcing-detail-submission.js";
import {SubmissionRequestError} from "../../apps/web/src/submission-validation.js";
vi.mock("../../apps/web/src/system-dialog.js",()=>({alertInApp:vi.fn(async()=>undefined)}));
const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-09-21T01:00:00.000Z";
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id, erpOrderId: "HISTORY", erpOrderNo: "HISTORY", styleNo: "OLD-STYLE", laneKey: "garment_processing", orderQuantity: 120,
  lineItems: [{ position: 1, styleNo: "OLD-STYLE", alternateStyleNo: null, color: "蓝色", quantity: 120, externalUnitPrice: null, legacy: false }],
  estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-20", processDescription: null, processes: [],
  status: "pending_management_decision", version: 2, createdBy: id, createdAt: at, updatedAt: at,
  ieQuote: { sourcingIeQuoteId: id, quoteVersion: 1, unitPrice: "12.34", quantity: 120, totalAmount: "1480.80", linePrices: [{position: 1, quantity: 120, unitPrice: "12.34", totalAmount: "1480.80"}], quoteReason: "当时报价说明", quotedBy: id, quotedAt: at },
  decision: null, ownerDecision: null,
});

type Pending={id:string;signal:AbortSignal;resolve:(item:SourcingCaseSummary)=>void;reject:(error:Error)=>void};
let host:HTMLDivElement,root:Root,pending:Pending[],current:ReturnType<typeof Harness>,busy=false;
const contractReturn={contractReturnMonitoring:false,contractReturnStatus:null,contractGeneratedAt:null,contractReturnDueAt:null,contractReturnedAt:null,contractReturnOverdueHours:null,uploadedByName:null,canUpload:false,attachments:[]};
const request:SourcingDetailRequest=async(path,schema,init)=>{
 if(/^sourcing\/cases\/[^/]+$/.test(path))return schema.parse(await new Promise<SourcingCaseSummary>((resolve,reject)=>pending.push({id:path.split("/").at(-1)!,signal:init!.signal as AbortSignal,resolve,reject})));
 if(path.endsWith("/detail-sections"))return schema.parse({sourcingCaseId:path.split("/").at(-2),version:item.version,
   attachments:{items:[]},timeline:{items:[]},factoryChange:{item:null}});
 return schema.parse(path.endsWith("/contract-return")?contractReturn:path.endsWith("/dispatch")?{item:null,canDispatch:false}:path.endsWith("/attachments")||path.endsWith("/timeline")?{items:[]}:{item:null});
};
function Harness({caseId,enabled=true}:{caseId:string;enabled?:boolean}){
 const read=useSourcingDetailRead(caseId,request,enabled),prices=useSourcingDetailPrices(caseId,read.snapshot?.item??null,()=>undefined),submission=useSourcingDetailSubmission(read,value=>{busy=value;});
 current={read,prices,submission};return current;
}
function Component(props:{caseId:string;enabled?:boolean}){Harness(props);return null;}
const render=async(caseId=id,enabled=true)=>{await act(async()=>root.render(createElement(Component,{caseId,enabled})));};
const complete=async(index:number,patch:Partial<SourcingCaseSummary>={})=>{await act(async()=>pending[index]!.resolve({...item,sourcingCaseId:pending[index]!.id,...patch}));};
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);host=document.createElement("div");document.body.append(host);root=createRoot(host);pending=[];busy=false;});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
it("rejects late success, failure and finally through a forced same-instance A to B to A generation",async()=>{
 await render();const old=pending[0]!;await render("00000000-0000-4000-8000-000000000002");await render();
 expect(pending).toHaveLength(3);expect(old.signal.aborted).toBe(true);expect(pending[1]!.signal.aborted).toBe(true);
 await complete(2,{styleName:"TEST latest A"});await complete(0,{styleName:"TEST stale A"});
 await act(async()=>pending[1]!.reject(Error("TEST old B failed")));
 expect(current.read.snapshot?.item.styleName).toBe("TEST latest A");expect(current.read.error).toBe("");expect(current.read.loading).toBe(false);expect(current.read.canSubmit).toBe(true);
});
it("does not expose another entity while its new GET is still pending or failed and can retry the target",async()=>{
 await render();await complete(0);await render("00000000-0000-4000-8000-000000000002");
 expect(current.read.snapshot).toBeNull();expect(current.read.canSubmit).toBe(false);
 await act(async()=>pending[1]!.reject(Error("TEST current failed")));expect(current.read.error).toBe("TEST current failed");
 let retry:Promise<unknown>;await act(async()=>{retry=current.read.reload();});await complete(2);await retry!;
 expect(current.read.snapshot?.item.sourcingCaseId).toBe(pending[2]!.id);expect(current.read.error).toBe("");
});
it("keeps a manually emptied price and reason across refresh and same-entity chapter changes, then resets on entity change",async()=>{
 await render();await complete(0);expect(current.prices.decision.linePrices[0]?.unitPrice).toBe("12.34");expect(current.prices.dirty).toBe(false);
 await act(async()=>current.prices.editDecision(value=>({...value,linePrices:value.linePrices.map(line=>({...line,unitPrice:""})),decisionReason:"TEST manual reason"})));
 await render(id,false);await render();await complete(1,{ieQuote:{...item.ieQuote!,linePrices:[{position:1,quantity:120,unitPrice:"15",totalAmount:"1800"}]}});
 expect(current.prices.decision.linePrices[0]?.unitPrice).toBe("");expect(current.prices.decision.decisionReason).toBe("TEST manual reason");expect(current.prices.dirty).toBe(true);
 await render("00000000-0000-4000-8000-000000000002");await complete(2);expect(current.prices.decision.decisionReason).toBe("");expect(current.prices.dirty).toBe(false);
});
it("ignores old write callbacks after leaving and returning without aborting the business operation",async()=>{
 await render();await complete(0);let resolve!:()=>void;const operation=new Promise<void>(done=>{resolve=done;}),saved=vi.fn();let result!:Promise<boolean>;
 await act(async()=>{result=current.submission.run(()=>operation,saved);});expect(busy).toBe(true);
 await render("00000000-0000-4000-8000-000000000002");await render();await complete(2);
 await act(async()=>{resolve();await result;});expect(saved).not.toHaveBeenCalled();expect(current.read.snapshot?.item.sourcingCaseId).toBe(id);
});
it("allows a same-entity refresh during a pending POST without invalidating its original write owner",async()=>{
 await render();await complete(0);let resolve!:(value:string)=>void;const operation=new Promise<string>(done=>{resolve=done;}),saved=vi.fn();let result!:Promise<boolean>,refresh!:Promise<unknown>;
 await act(async()=>{result=current.submission.run(()=>operation,saved);refresh=current.read.reload();});await complete(1);await refresh;
 await act(async()=>{resolve("TEST committed");await result;});expect(saved).toHaveBeenCalledOnce();expect(saved.mock.calls[0]![0]).toBe("TEST committed");
});
it("retains the original recovery operation instead of accepting a new command after a lost receipt",async()=>{
 await render();await complete(0);const first=vi.fn().mockRejectedValueOnce(new SubmissionRequestError("TEST lost receipt","UNAVAILABLE",503)).mockResolvedValue("TEST original response"),saved=vi.fn(),replacement=vi.fn();
 await act(async()=>{await current.submission.run(first,saved);});expect(current.submission.feedback.uncertain).toBe(true);
 await act(async()=>{await current.submission.run(replacement,saved);});expect(replacement).not.toHaveBeenCalled();
 await act(async()=>{await current.submission.feedback.retry();});expect(first).toHaveBeenCalledTimes(2);expect(saved.mock.calls[0]![0]).toBe("TEST original response");expect(current.submission.feedback.uncertain).toBe(false);
});
it("checks a captured identity when applying a write response as well as when reading",async()=>{
 await render();await complete(0);const identity=current.read.capture(),apply=current.read.apply;
 await render("00000000-0000-4000-8000-000000000002");await render();await complete(2,{styleName:"TEST new generation"});
 await act(async()=>apply(identity,{item:{...item,styleName:"TEST old write"}}));expect(current.read.snapshot?.item.styleName).toBe("TEST new generation");
});


it("keeps the authorized overview available and rejects a contract return from a different current document",async()=>{
 const anotherDocument="00000000-0000-4000-8000-000000000002";
 let currentDocument=anotherDocument;
 const fetchDetail:SourcingDetailRequest=async(path,schema,init)=>{
  if(path===`sourcing/cases/${id}`)return schema.parse(item);
  if(path.endsWith("/contract"))return schema.parse({item:{
   sourcingContractDocumentId:id,sourcingApprovalSnapshotId:id,contractNumber:"TEST-CURRENT",contractVersion:1,templateVersion:1,
   status:"ready",missingFields:[],snapshotFingerprint:null,pdfAttachmentId:null,pdfSha256:null,failureReason:null,
   preparedAt:at,generatedAt:at,canSupplement:false,
  }});
  if(path.endsWith("/contract-return"))return schema.parse({...contractReturn,currentContractDocumentId:currentDocument});
  return request(path,schema,init);
 };
 const signal=new AbortController().signal,overview=vi.fn();
 await expect(readSourcingDetail(fetchDetail,id,signal,{item:overview})).rejects.toThrow("本单已更新");
 expect(overview).toHaveBeenCalledWith(item);
 currentDocument=id;
 const refreshed=await readSourcingDetail(fetchDetail,id,signal);
 expect(refreshed.contract?.sourcingContractDocumentId).toBe(refreshed.contractReturn.currentContractDocumentId);
});

it.each([true,false])("only previews the approved current contract while other sections load (matching approval: %s)",async sameApproval=>{
 const otherApproval="00000000-0000-4000-8000-000000000003";
 const approvedItem=SourcingCaseSummarySchema.parse({...item,approvalSnapshot:{
  sourcingApprovalSnapshotId:id,sourcingDecisionId:id,decisionVersion:1,
  supplierId:id,supplierCode:"TEST-FACTORY",supplierName:"TEST 厂",quantity:120,totalAmount:"1480.80",
  estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",processes:[],
  linePrices:[{position:1,styleNo:item.styleNo,alternateStyleNo:null,color:"蓝色",quantity:120,unitPrice:"12.34",totalAmount:"1480.80"}],
  approvedBy:id,approvedAt:at,
 }});
 const contract={sourcingContractDocumentId:id,sourcingApprovalSnapshotId:sameApproval?id:otherApproval,
  contractNumber:"TEST-CURRENT",contractVersion:1,templateVersion:1,status:"ready",missingFields:[],
  snapshotFingerprint:null,pdfAttachmentId:null,pdfSha256:null,failureReason:null,preparedAt:at,generatedAt:at,canSupplement:false};
 let releaseDispatch!:()=>void;
 const held=new Promise<void>(resolve=>{releaseDispatch=resolve;});
 const load:SourcingDetailRequest=async(path,schema,init)=>{
  if(path===`sourcing/cases/${id}`)return schema.parse(approvedItem);
  if(path.endsWith("/contract"))return schema.parse({item:contract});
  if(path.endsWith("/contract-return"))return schema.parse({...contractReturn,currentContractDocumentId:id});
  if(path.endsWith("/dispatch"))await held;
  return request(path,schema,init);
 };
 const sections=vi.fn(),settled=vi.fn();
 const pending=readSourcingDetail(load,id,new AbortController().signal,{sections});
 void pending.then(settled,settled);
 try {
  await vi.waitFor(()=>expect(sections).toHaveBeenCalledWith({attachments:[]}));
  const previews=sections.mock.calls.flatMap(([section])=>section.contract?[section.contract]:[]);
  expect(previews.map(preview=>preview.sourcingApprovalSnapshotId)).toEqual(sameApproval?[id]:[]);
  expect(settled).not.toHaveBeenCalled();
 } finally { releaseDispatch(); }
 const loaded=await pending;
 expect(loaded.contract?.sourcingContractDocumentId).toBe(id);
});

it("publishes independently verified attachments ahead of dispatch and reports the actual revoked read",async()=>{
 let rejectDispatch!:(reason:Error)=>void;
 const held=new Promise((_,reject)=>{rejectDispatch=reject;});
 const load:SourcingDetailRequest=async(path,schema,init)=>{
  if(path===`sourcing/cases/${id}`)return schema.parse(item);
  if(path.endsWith("/dispatch"))return schema.parse(await held);
  return request(path,schema,init);
 };
 const attachments=vi.fn(),denied=vi.fn(),settled=vi.fn();
 const pending=readSourcingDetail(load,id,new AbortController().signal,{sections:attachments,denied});
 void pending.then(settled,settled);
 await vi.waitFor(()=>expect(attachments).toHaveBeenCalledWith({attachments:[]}));
 expect(settled).not.toHaveBeenCalled();
 const revoked=new SubmissionRequestError("TEST scope revoked", "FORBIDDEN",403);
 rejectDispatch(revoked);
 await expect(pending).rejects.toBe(revoked);
 expect(denied).toHaveBeenCalledExactlyOnceWith(revoked);
});

it("rejects standalone record retry when the authoritative case revision changes",async()=>{
 let summaries=0;
 const routes:string[]=[];
 const load:SourcingDetailRequest=async(path,schema,init)=>{
  routes.push(path);
  if(path===`sourcing/cases/${id}`)return schema.parse({...item,version:item.version+summaries++});
  return request(path,schema,init);
 };
 const sections=vi.fn();
 await expect(readSourcingDetail(load,id,new AbortController().signal,{sections},true))
  .rejects.toThrow("本单已更新");
 expect(sections).not.toHaveBeenCalled();
 expect(routes.filter(path=>path===`sourcing/cases/${id}`)).toHaveLength(2);
 for(const group of ["/attachments","/timeline","/factory-changes/current"])
  expect(routes.filter(path=>path===`sourcing/cases/${id}${group}`)).toHaveLength(1);
 expect(routes.some(path=>path.endsWith("/detail-sections"))).toBe(false);
});

it.each([false,true])("does not expose the prior approval's contract while reading a newer overview (prior full snapshot: %s)",async hadSnapshot=>{
 const nextApproval="00000000-0000-4000-8000-000000000003";
 const approval={
  sourcingApprovalSnapshotId:id,sourcingDecisionId:id,decisionVersion:1,
  supplierId:id,supplierCode:"TEST-FACTORY",supplierName:"TEST 厂",quantity:120,totalAmount:"1480.80",
  estimatedCutPieceSendDate:"2026-10-01",deliveryDate:"2026-10-20",processes:[],
  linePrices:[{position:1,styleNo:item.styleNo,alternateStyleNo:null,color:"蓝色",quantity:120,unitPrice:"12.34",totalAmount:"1480.80"}],
  approvedBy:id,approvedAt:at,
 };
 const oldOverview=SourcingCaseSummarySchema.parse({...item,approvalSnapshot:approval});
 const newOverview=SourcingCaseSummarySchema.parse({...item,version:hadSnapshot?item.version:item.version+1,styleNo:"NEW-STYLE",approvalSnapshot:{...approval,sourcingApprovalSnapshotId:nextApproval,decisionVersion:2}});
 const oldContract={
  sourcingContractDocumentId:id,sourcingApprovalSnapshotId:id,contractNumber:"TEST-OLD-CONTRACT",contractVersion:1,templateVersion:1,
  status:"ready",missingFields:[],snapshotFingerprint:null,pdfAttachmentId:id,pdfSha256:"a".repeat(64),failureReason:null,
  preparedAt:at,generatedAt:at,canSupplement:false,
 };
 let newer=false;
 const pendingContract=Promise.withResolvers<never>();
 const fetchDetail:SourcingDetailRequest=async(path,schema,init)=>{
  if(path===`sourcing/cases/${id}`)return schema.parse(newer?newOverview:oldOverview);
  if(path.endsWith("/detail-sections")){
   if(!hadSnapshot)throw Error("TEST grouped records temporarily unavailable");
   return schema.parse({sourcingCaseId:id,version:(newer?newOverview:oldOverview).version,
     attachments:{items:[]},timeline:{items:[]},factoryChange:{item:null}});
  }
  if(path.endsWith("/contract"))return newer?await pendingContract.promise:schema.parse({item:oldContract});
  if(path.endsWith("/contract-return"))return schema.parse({...contractReturn,currentContractDocumentId:newer?nextApproval:id});
  return request(path,schema,init);
 };
 let read!:ReturnType<typeof useSourcingDetailRead>;
 function Probe(){
  read=useSourcingDetailRead(id,fetchDetail);
  return null;
 }
 await act(async()=>root.render(createElement(Probe)));
 expect(read.recordsFailed).toBe(!hadSnapshot);
 expect((read.snapshot?.contract??read.readOnly.contract)?.sourcingContractDocumentId).toBe(id);
 newer=true;
 let done!:Promise<unknown>;
 await act(async()=>{done=(hadSnapshot?read.reload():read.retryRecords()).catch(error=>error);});
 expect(read.overview?.version).toBe(newOverview.version);
 expect(read.overview?.approvalSnapshot?.sourcingApprovalSnapshotId).toBe(nextApproval);
 expect(read.snapshot).toBeNull();
 expect(read.readOnly.contract).toBeUndefined();
 expect(read.canSubmit).toBe(false);
 await act(async()=>{pendingContract.reject(Error("TEST new contract unavailable"));await done;});
 expect(read.error).toContain("new contract unavailable");
 expect(read.readOnly.contract).toBeUndefined();
 expect(read.canSubmit).toBe(false);
});
