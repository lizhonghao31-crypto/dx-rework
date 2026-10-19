// Include the application static CSS cascade without mounting unrelated pages.
import "../../apps/web/src/App.js";
import { createRoot } from "react-dom/client";
import { SourcingCaseSummarySchema, SourcingNodeHistorySchema, type SourcingHistoryNode } from "@dx-rework/contracts";
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
const reference = true;
const node = (params.get("node") ?? "owner") as SourcingHistoryNode;
const historical = params.get("view") === "node-history";
const finance = node === "finance" || historical && node === "owner";
const nodeIndex = ["created","ie_quote","management","owner","finance"].indexOf(node);
const currentStatus = {created:"pending_merchandiser_correction",ie_quote:"pending_ie_quote",management:"pending_management_decision",owner:"pending_owner_approval",finance:"pending_finance_reconciliation"} as const;
const prices = Array.from({ length: reference ? 6 : 3 }, (_, i) => ({ position: i + 1, quantity: reference ? 200 + i * 50 : 1000, unitPrice: reference ? `${36 + i}.0000` : `${12 + i}.3000`, totalAmount: `${reference ? (200 + i * 50) * (36 + i) : 12300 + i * 1000}.00` }));
const productionPrices = reference ? prices.map((p,i)=>({...p,unitPrice:`${37+i}.0000`,totalAmount:`${p.quantity*(37+i)}.00`})) : prices;
const baseItem = SourcingCaseSummarySchema.parse({
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

const partial = params.get("variant") === "partial";
const defaultItem = SourcingCaseSummarySchema.parse({...baseItem,merchandiserName:"TEST 主跟单",status:historical?({created:"pending_ie_quote",ie_quote:"pending_management_decision",management:"pending_owner_approval",owner:"pending_finance_reconciliation",finance:"closed"} as const)[node]:currentStatus[node],correctionReason:node==="created"?"TEST 合成退回说明":null,
 ieQuote:nodeIndex===0||nodeIndex===1&&!historical?null:baseItem.ieQuote,
 decision:nodeIndex<3&&!historical||nodeIndex<2?null:partial?{...baseItem.decision!,sourceType:"factory_change",quantity:450,totalAmount:"16900.00",linePrices:productionPrices.slice(0,2)}:baseItem.decision,
});
// Visible fields mirror the supplied screenshot; undisclosed fields remain valid synthetic TEST data.
const deployed = params.get("variant") === "deployed";
const comparisonLines = [{ ...baseItem.lineItems[0]!, styleNo:"TEST-PO-C01-P01", quantity:5, customerWarehouseArrivalDate:"2026-12-01", factoryDeliveryDate:"2026-11-20", proposedFactoryDeliveryDate:"2026-11-20" }];
const comparisonPrices = [{ ...prices[0]!, quantity:5, unitPrice:"10.0000", totalAmount:"50.00" }];
const item = deployed ? SourcingCaseSummarySchema.parse({ ...defaultItem,
  styleNo:"TEST-UX-20261016-V3-C01-P01", gender:"男装", styleName:"TEST 单PO基础T恤", merchandiserName:"[UAT] 订单跟单",
  orderQuantity:5, estimatedCutPieceSendDate:"2026-10-20", deliveryDate:"2026-11-20", lineItems:comparisonLines,
  ieQuote:{...baseItem.ieQuote!,quantity:5,totalAmount:"50.00",linePrices:comparisonPrices},
  decision:{...baseItem.decision!,supplierName:"TEST-UAT-1006-FACTORY2",quantity:5,totalAmount:"50.00",linePrices:comparisonPrices},
  approvalSnapshot:baseItem.approvalSnapshot?{...baseItem.approvalSnapshot,quantity:5,totalAmount:"50.00",linePrices:comparisonPrices.map((price,i)=>({...price,styleNo:comparisonLines[i]!.styleNo,color:comparisonLines[i]!.color,alternateStyleNo:null}))}:null,
}) : defaultItem;

const requests:{path:string;method:string;body:unknown}[]=[];
const role=params.get("role")??({created:"merchandiser",ie_quote:"ie",management:"management",owner:"owner",finance:"finance"})[node];
const rolePolicy:Record<string,{role:string;capabilities:string[]}>= {
 root:{role:"root_superuser",capabilities:[]},owner:{role:"owner_group",capabilities:["sourcing:owner:approve"]},
 ie:{role:"ie_reviewer",capabilities:["sourcing:price:quote"]},management:{role:"production_management",capabilities:["sourcing:decision:record"]},
 finance:{role:"factory_payables",capabilities:["sourcing:finance:reconcile",...(params.get("contract")==="denied"?[]:["supplier_contract_data:read"])]},
 merchandiser:{role:"order_merchandiser",capabilities:["sourcing:inquiry:create","sourcing:view"]},readonly:{role:"owner_group",capabilities:["sourcing:owner:approve"]},
 denied:{role:"worker",capabilities:[]},
};
const policy=rolePolicy[role]!;
const user={id:id(1),displayName:`TEST ${role}`,isRoot:role==="root",businessRoles:[policy.role],capabilities:policy.capabilities,...(role==="readonly"?{readOnlyModules:["sourcing"]}:{})};

const attachments=Array.from({length:deployed?1:reference?3:6},(_,i)=>({attachmentId:id(200+i),filename:`TEST-合成款式原始长文件名-秋季外套-${i+1}.png`,mimeType:"image/png"}));
const kind={created:"created",ie_quote:"ie_quote",management:"management_decision",owner:"owner_decision",finance:"finance_reconciliation"} as const;
const entry={entryId:id(400),kind:kind[node],version:2,handledBy:`TEST 当时${node}`,handledAt:now,reason:"TEST 合成历史办理说明",unitPrice:null,totalAmount:null,supplierName:null,decision:node==="owner"?"approved":null,contractReference:null,signedOn:null,quantity:null,differenceFields:[],result:node==="finance"?"match":null,resolution:null};
const oldEntry={...entry,entryId:id(401),version:1,handledBy:"TEST 历史办理人V1",reason:"TEST 旧版本办理说明"};

Object.assign(window,{orderLayoutFixture:{requests,family:"sourcing",item,role,node,historical,partial}});
window.fetch=async(input,init)=>{const path=String(input),method=init?.method??"GET";requests.push({path,method,body:init?.body?JSON.parse(String(init.body)):null});
if(method!=="GET")return Response.json({error:{message:"隔离场景，未提交业务数据"}},{status:403});
if(path.endsWith("auth/me"))return Response.json({status:"authorized",user});
if(path.includes("/history/")){
 if(params.get("variant")==="missing"||role==="denied")return Response.json({error:{message:"TEST no historical access"}},{status:params.get("variant")==="missing"?404:403});
 const older=new URL(path,location.origin).searchParams.get("entryId")===oldEntry.entryId;
 const snapshot={...item,lineItems:item.lineItems.map(line=>{const historicalLine={...line};delete historicalLine.customerWarehouseArrivalDate;return historicalLine;}),styleNo:older?"TEST 历史款号V1":item.styleNo,decision:item.decision?{...item.decision,supplierName:older?"TEST 历史加工厂V1":"TEST 当时加工厂"}:null};
 return Response.json(SourcingNodeHistorySchema.parse({item:snapshot,node,entry:older?oldEntry:entry,versions:[oldEntry,entry],relatedEntries:[],attachments,notices:[],contractReference:node==="finance"?"TEST-HISTORY-CONTRACT":null}));
}
if(path.endsWith("/attachments"))return Response.json({items:attachments});
if(path.endsWith("/factories"))return Response.json({items:[{supplierId:id(4),supplierCode:"TEST-FACTORY",supplierName:"TEST 合成加工厂",supportedCrafts:["合成缝制"],dailyCapacity:1000,notes:"TEST 合成资料",contractDataMissing:[]}]});
if(path.endsWith("/timeline")||path.endsWith("/factory-settlements"))return Response.json({items:[]});
if(path.endsWith("/dispatch"))return Response.json({item:null,canDispatch:false});
if(finance&&path.endsWith("/contract"))return Response.json({item:{sourcingContractDocumentId:id(500),sourcingApprovalSnapshotId:id(501),contractNumber:"MOCK-HT-2026-001",contractVersion:1,templateVersion:1,status:"ready",missingFields:[],snapshotFingerprint:"a".repeat(64),pdfAttachmentId:id(502),pdfSha256:"b".repeat(64),failureReason:null,preparedAt:now,generatedAt:now,canSupplement:false}});
if(path.endsWith("/contract")||path.endsWith("/factory-changes/current"))return Response.json({item:null});
if(path.endsWith("/contract-return"))return Response.json({contractReturnMonitoring:finance,contractReturnStatus:finance?"pending":null,contractGeneratedAt:finance?now:null,contractReturnDueAt:finance?"2026-09-14T00:00:00.000Z":null,contractReturnedAt:null,contractReturnOverdueHours:null,uploadedByName:null,canUpload:finance&&params.get("contract")!=="denied",attachments:[],history:[]});
if(path.endsWith(`/cases/${id(100)}`))return role==="denied"?Response.json({error:{message:"TEST 当前订单不可读"}},{status:403}):Response.json(item);
if(path.includes("master-data/crafts")||path.includes("sourcing/styles"))return Response.json([]);
throw new Error(`Unexpected synthetic read: ${path}`);};
createRoot(document.getElementById("root")!).render(<SourcingWorkspacePage view="detail" sourcingCaseId={id(100)}/>);
