// Include the application static CSS cascade without mounting unrelated pages.
import "../../apps/web/src/App.js";
import { createRoot } from "react-dom/client";
import { SourcingCaseSummarySchema } from "@dx-rework/contracts";
import { SourcingWorkspacePage } from "../../apps/web/src/sourcing-workspace-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/ui-polish.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/workflow-state-visual.css";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-07T00:00:00.000Z";
const params = new URLSearchParams(location.search);
const reference = params.get("reference") === "1";
const finance = params.get("node") === "finance";
const prices = Array.from({ length: reference ? 6 : 3 }, (_, i) => ({ position: i + 1, quantity: reference ? 200 + i * 50 : 1000, unitPrice: reference ? `${36 + i}.0000` : `${12 + i}.3000`, totalAmount: `${reference ? (200 + i * 50) * (36 + i) : 12300 + i * 1000}.00` }));
const productionPrices = reference ? prices.map((p,i)=>({...p,unitPrice:`${37+i}.0000`,totalAmount:`${p.quantity*(37+i)}.00`})) : prices;
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id(100), erpOrderId: "FIXTURE-100", erpOrderNo: "合成订单-100", styleNo: reference ? "模拟款号-DX秋冬轻户外双层防风长款连帽抽绳女装系列-2026-A01" : "TEST-DX-2026-秋季外套-01", laneKey: "garment_processing",
  gender: "女装", styleName: "合成款式", orderQuantity: reference ? 1950 : 3000,
  lineItems: prices.map((p, i) => ({ position: p.position, lineId:id(300+i), customerWarehouseArrivalDate:i===2?null:"2027-01-15", factoryDeliveryDate:i===2?null:"2026-12-28", proposedFactoryDeliveryDate:i===2?null:"2026-12-28", styleNo: reference ? `MOCK-PO-2610${i+1}` : `DX-2026-秋季长款号-${i + 1}-SAMPLE`, alternateStyleNo: reference ? `模拟代用-0${i+1}` : null, color: reference ? ["墨绿色","雾霾蓝","暖沙色","米白色","深石灰","陶土棕"][i] : i ? "蓝色" : "白色", quantity: p.quantity, externalUnitPrice: p.unitPrice, legacy: false })),
  daxingUnitPrice: "20.0000", estimatedCutPieceSendDate: "2026-09-10", deliveryDate: "2026-09-15", processDescription: null, processes: ["合成缝制"],
  status: finance ? "pending_finance_reconciliation" : "pending_owner_approval", version: 4, createdBy: id(1), createdAt: now, updatedAt: now,
  ieQuote: { sourcingIeQuoteId: id(2), quoteVersion: 1, unitPrice: "12.3000", quantity: reference ? 1950 : 3000, totalAmount: reference ? "75950.00" : "39900.00", linePrices: prices, quoteReason: "合成逐款报价", quotedBy: id(1), quotedAt: now },
  decision: { sourcingDecisionId: id(3), decisionVersion: 1, sourceType: "initial", sourceIeQuoteId: id(2), supersedesDecisionId: null, supplierId: id(4), supplierCode: "FAC-FIXTURE", supplierName: reference ? "模拟工厂·南岭制衣" : "合成·达兴服装加工合作工厂（秋季订单承接车间）", unitPrice: "12.3000", quantity: reference ? 1950 : 3000, totalAmount: reference ? "77900.00" : "39900.00", linePrices: productionPrices, decisionReason: "合成批准事实", decidedBy: id(1), decidedAt: now },
  approvalSnapshot: finance ? {sourcingApprovalSnapshotId:id(501),sourcingDecisionId:id(3),decisionVersion:1,supplierId:id(4),supplierCode:"FAC-FIXTURE",supplierName:reference?"模拟工厂·南岭制衣":"合成加工厂",quantity:reference?1950:3000,totalAmount:reference?"77900.00":"39900.00",daxingUnitPrice:"20.0000",estimatedCutPieceSendDate:"2026-09-10",deliveryDate:"2026-09-15",processes:["合成缝制"],linePrices:productionPrices.map((p,i)=>({...p,styleNo:reference?`MOCK-PO-2610${i+1}`:`DX-2026-秋季长款号-${i+1}-SAMPLE`,alternateStyleNo:reference?`模拟代用-0${i+1}`:null,color:reference?["墨绿色","雾霾蓝","暖沙色","米白色","深石灰","陶土棕"][i]:i?"蓝色":"白色"})),approvedBy:id(1),approvedAt:now} : null,
  ownerDecision: finance ? { sourcingOwnerDecisionId:id(5), sourcingDecisionId:id(3),decision:"approved",decisionReason:"合成原批准事实",decidedBy:id(1),decidedAt:now } : null,
});

const requests:{path:string;method:string;body:unknown}[]=[];
const user={id:id(1),displayName:finance?"TEST 财务":"TEST 老板",isRoot:!["readonly","owner","finance"].includes(params.get("role")??"root"),businessRoles:[finance?"factory_payables":"owner_group"],capabilities:params.get("role")==="finance"?["sourcing:finance:reconcile",...(params.get("contract")==="denied"?[]:["supplier_contract_data:read"])]:params.get("role")==="owner"?["sourcing:owner:approve"]:[],...(params.get("role")==="readonly"?{readOnlyModules:["sourcing"]}:{})};
const attachments=Array.from({length:reference?3:6},(_,i)=>({attachmentId:id(200+i),filename:`TEST-合成款式原始长文件名-秋季外套-${i+1}.png`,mimeType:"image/png"}));
const entry={entryId:id(400),kind:"owner_decision",version:1,handledBy:"TEST 老板",handledAt:now,reason:"合成原批准事实",unitPrice:null,totalAmount:null,supplierName:null,decision:"approved",contractReference:null,signedOn:null,quantity:null,differenceFields:[],result:null,resolution:null};
Object.assign(window,{orderLayoutFixture:{requests,family:"sourcing",item}});
window.fetch=async(input,init)=>{const path=String(input),method=init?.method??"GET";requests.push({path,method,body:init?.body?JSON.parse(String(init.body)):null});
if(method!=="GET")return Response.json({error:{message:"隔离场景，未提交业务数据"}},{status:403});
if(path.endsWith("auth/me"))return Response.json({status:"authorized",user});
if(path.includes("/history/owner"))return Response.json({item:{...item,status:"pending_finance_reconciliation",ownerDecision:{sourcingOwnerDecisionId:id(5),sourcingDecisionId:id(3),decision:"approved",decisionReason:"合成原批准事实",decidedBy:id(1),decidedAt:now}},node:"owner",entry,versions:[entry],relatedEntries:[],attachments,notices:[],contractReference:null});
if(path.endsWith("/attachments"))return Response.json({items:attachments});
if(path.endsWith("/timeline")||path.endsWith("/factories")||path.endsWith("/factory-settlements"))return Response.json({items:[]});
if(path.endsWith("/dispatch"))return Response.json({item:null,canDispatch:false});
if(finance&&path.endsWith("/contract"))return Response.json({item:{sourcingContractDocumentId:id(500),sourcingApprovalSnapshotId:id(501),contractNumber:"MOCK-HT-2026-001",contractVersion:1,templateVersion:1,status:"ready",missingFields:[],snapshotFingerprint:"a".repeat(64),pdfAttachmentId:id(502),pdfSha256:"b".repeat(64),failureReason:null,preparedAt:now,generatedAt:now,canSupplement:false}});
if(path.endsWith("/contract")||path.endsWith("/factory-changes/current"))return Response.json({item:null});
if(path.endsWith("/contract-return"))return Response.json({contractReturnMonitoring:finance,contractReturnStatus:finance?"pending":null,contractGeneratedAt:finance?now:null,contractReturnDueAt:finance?"2026-09-14T00:00:00.000Z":null,contractReturnedAt:null,contractReturnOverdueHours:null,uploadedByName:null,canUpload:finance&&params.get("contract")!=="denied",attachments:[],history:[]});
if(path.endsWith(`/cases/${id(100)}`))return Response.json(item);
if(path.includes("master-data/crafts")||path.includes("sourcing/styles"))return Response.json([]);
throw new Error(`Unexpected synthetic read: ${path}`);};
createRoot(document.getElementById("root")!).render(<SourcingWorkspacePage view="detail" sourcingCaseId={id(100)}/>);
