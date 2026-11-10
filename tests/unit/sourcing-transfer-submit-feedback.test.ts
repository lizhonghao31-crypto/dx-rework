// @vitest-environment jsdom
import {act,createElement,type ReactNode} from "react";
import {createRoot,type Root} from "react-dom/client";
import {SourcingCaseSummarySchema} from "@dx-rework/contracts";
import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
vi.mock("../../apps/web/src/auth.js",()=>({verifySession:async()=>({status:"authorized",user})}));
vi.mock("../../apps/web/src/components.js",()=>({Shell:({children}:{children:ReactNode})=>createElement("div",null,children),Header:()=>null}));
vi.mock("../../apps/web/src/search-select.js",()=>({SearchableSelect:(props:Record<string,unknown>)=>createElement("select",props)}));
vi.mock("../../apps/web/src/system-dialog.js",()=>({alertInApp:vi.fn(async()=>undefined),confirmInApp:vi.fn(async()=>true)}));
import {SourcingWorkspacePage} from "../../apps/web/src/sourcing-workspace-page.js";
const id = (number: number) => `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
const now = "2026-10-24T00:00:00.000Z";
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id(100), erpOrderId: "TEST", erpOrderNo: "TEST", styleNo: "TEST-TRANSFER", laneKey: "garment_processing",
  gender: "女装", styleName: "TEST", orderQuantity: 1000,
  lineItems: [{ position: 1, styleNo: "TEST-TRANSFER", alternateStyleNo: null, color: "蓝", quantity: 1000, externalUnitPrice: null, legacy: false }],
  estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-11-05", processDescription: null, processes: ["TEST-车缝"],
  status: "pending_finance_reconciliation", version: 4, createdBy: id(1), createdAt: now, updatedAt: now,
  ieQuote: null, ownerDecision: null,
  decision: { sourcingDecisionId: id(3), decisionVersion: 2, sourceType: "factory_change", sourceIeQuoteId: null,
    supersedesDecisionId: id(2), supplierId: id(4), supplierCode: "TEST-OLD", supplierName: "TEST原工厂", unitPrice: "12.8",
    quantity: 1000, totalAmount: "12800", linePrices: [{ position: 1, quantity: 1000, unitPrice: "12.8", totalAmount: "12800" }],
    decisionReason: "TEST", decidedBy: id(1), decidedAt: now },
  approvalSnapshot: { sourcingApprovalSnapshotId: id(6), sourcingDecisionId: id(3), decisionVersion: 2,
    supplierId: id(4), supplierCode: "TEST-OLD", supplierName: "TEST原工厂", quantity: 1000, totalAmount: "12800",
    estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-11-05", processes: ["TEST-车缝"],
    linePrices: [{ position: 1, styleNo: "TEST-TRANSFER", alternateStyleNo: null, color: "蓝", quantity: 1000, unitPrice: "12.8", totalAmount: "12800" }],
    approvedBy: id(1), approvedAt: now },
});
const user = { id: id(1), displayName: "TEST root", isRoot: true, businessRoles: ["root_superuser"], capabilities: ["sourcing:view"] };
const contractReturn = { contractReturnMonitoring: false, contractReturnStatus: null, contractGeneratedAt: null,
  contractReturnDueAt: null, contractReturnedAt: null, contractReturnOverdueHours: null, uploadedByName: null, canUpload: false, attachments: [] };


let host:HTMLDivElement,root:Root;
const button=(text:string)=>[...host.querySelectorAll<HTMLButtonElement>("button")].find(node=>node.textContent===text)!;
async function setup(postFails:boolean|"unknown"){
 let posted=false,postCount=0;
 const fetchMock=vi.fn(async(input:string,init?:RequestInit)=>{
  if(init?.method==="POST"){posted=true;postCount++;if(postFails==="unknown"&&postCount===1)return Response.json({error:{message:"TEST unknown receipt",code:"TEST_RECEIPT_LOST"}},{status:503});return postFails===true?Response.json({error:{message:"TEST-转厂提交被拒绝",code:"INVALID_STATE_TRANSITION",requestId:"TEST-submit-refused"}},{status:409}):Response.json({...item,decision:{...item.decision!,supplierId:id(5),supplierName:"TEST新工厂"}},{status:201});}
  if(input.endsWith("/timeline"))return posted?Response.json({error:{message:"TEST-订单页面刷新失败"}},{status:500}):Response.json({items:[]});
  if(input.endsWith(`/cases/${id(100)}`))return Response.json(item);
  if(input.endsWith("/attachments"))return Response.json({items:[]});
  if(input.endsWith("/dispatch"))return Response.json({item:null,canDispatch:false});
  if(input.endsWith("/contract-return"))return Response.json(contractReturn);
  if(input.endsWith("/factories"))return Response.json({items:[{supplierId:id(5),supplierCode:"TEST-NEW",supplierName:"TEST新工厂"}]});
  if(input.includes("master-data/crafts"))return Response.json([]);
  return Response.json({item:null});
 });
 vi.stubGlobal("fetch",fetchMock);
 await act(async()=>root.render(createElement(SourcingWorkspacePage,{view:"detail",sourcingCaseId:item.sourcingCaseId})));
 await act(async()=>{button("订单转厂").click();});
 for(const [label,value] of [["新加工厂",id(5)],["新加工单价","11.3"],["转厂原因","TEST-转厂原因"]]){
  const field=[...host.querySelectorAll("label")].find(node=>node.querySelector("span")?.textContent===label)!.querySelector("input,select") as HTMLInputElement|HTMLSelectElement;
  await act(async()=>{Object.getOwnPropertyDescriptor(field instanceof HTMLSelectElement?HTMLSelectElement.prototype:HTMLInputElement.prototype,"value")!.set!.call(field,value);field.dispatchEvent(new Event(field instanceof HTMLSelectElement?"change":"input",{bubbles:true}));});
 }
 // The original 150ms craft lookup belongs to initial loading, not POST
 // recovery. Settle it before measuring whether a refused write refreshes.
 await act(async()=>{await vi.waitFor(()=>expect(fetchMock.mock.calls.some(([path,init])=>path.includes("master-data/crafts")&&init?.method!=="POST")).toBe(true));});
 expect(button("提交转厂").disabled).toBe(false);return fetchMock;
}
beforeEach(()=>{vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT",true);Element.prototype.scrollIntoView=vi.fn();host=document.createElement("div");document.body.append(host);root=createRoot(host);});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.unstubAllGlobals();});
describe("actual transfer submission and refresh feedback",()=>{
 it("retains confirmed success when the following GET fails without a second POST",async()=>{
  const fetchMock=await setup(false),before=fetchMock.mock.calls.length;
  await act(async()=>button("提交转厂").click());
  await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain("提交已成功，但页面更新未完成"));});
  expect(host.textContent).toContain("老板发起的转厂已直接生效");expect(host.textContent).toContain("TEST-订单页面刷新失败");
  expect(fetchMock.mock.calls.filter(([,init])=>init?.method==="POST")).toHaveLength(1);
  expect(fetchMock.mock.calls.length-before).toBe(8);expect(button("提交转厂").disabled).toBe(true);
  // A failed refresh is not permission to submit against a stale snapshot.
  expect(host.textContent).not.toContain("核对上次提交结果");
 });
 it("shows a refused POST as failure without attempting a refresh",async()=>{
  const fetchMock=await setup(true),before=fetchMock.mock.calls.length;
  await act(async()=>button("提交转厂").click());
  await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain("TEST-转厂提交被拒绝"));});
  expect(host.textContent).not.toContain("老板发起的转厂已直接生效");expect(fetchMock.mock.calls.length-before).toBe(1);expect(button("提交转厂").disabled).toBe(false);
 });
 it("freezes transfer inputs and recovers the original request after an unknown receipt",async()=>{
  const fetchMock=await setup("unknown");await act(async()=>button("提交转厂").click());
  await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain("核对上次提交结果"));});
  const input=[...host.querySelectorAll("label")].find(node=>node.querySelector("span")?.textContent==="新加工单价")!.querySelector("input")!;
  expect(input.disabled).toBe(true);const first=fetchMock.mock.calls.find(([,init])=>init?.method==="POST")![1]!;
  await act(async()=>button("核对上次提交结果").click());
  await act(async()=>{await vi.waitFor(()=>expect(host.textContent).toContain("提交已成功，但页面更新未完成"));});
  const posts=fetchMock.mock.calls.filter(([,init])=>init?.method==="POST");expect(posts).toHaveLength(2);expect(posts[1]![1]?.body).toBe(first.body);expect(posts[1]![1]?.headers).toEqual(first.headers);
 });
});
