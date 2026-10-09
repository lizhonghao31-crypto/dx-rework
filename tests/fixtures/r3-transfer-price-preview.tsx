import { createRoot } from "react-dom/client";
import { SourcingCaseSummarySchema } from "@dx-rework/contracts";
import { SourcingWorkspacePage } from "../../apps/web/src/sourcing-workspace-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-07T00:00:00.000Z";
const multiple = new URLSearchParams(location.search).has("multi");
const prices = (multiple ? [1, 1] : [20]).map((quantity,index)=>({position:index+1,quantity,unitPrice:"4.1234",totalAmount:multiple?"4.12":"82.47"}));
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id(100), erpOrderId: "FIXTURE-100", erpOrderNo: "合成订单-100", styleNo: "DX-A", laneKey: "garment_processing",
  gender: "女装", styleName: "合成款式", orderQuantity: multiple?2:20,
  lineItems: prices.map((p, i) => ({ position: p.position, styleNo: i ? "DX-B" : "DX-A", alternateStyleNo: null, color: i ? "蓝色" : "白色", quantity: p.quantity, externalUnitPrice: p.unitPrice, legacy: false })),
  daxingUnitPrice: "20.0000", estimatedCutPieceSendDate: "2026-09-10", deliveryDate: "2026-09-15", processDescription: null, processes: ["合成缝制"],
  status: "pending_finance_reconciliation", version: 4, createdBy: id(1), createdAt: now, updatedAt: now,
  ieQuote: { sourcingIeQuoteId: id(2), quoteVersion: 1, unitPrice: "4.1234", quantity: multiple?2:20, totalAmount: multiple?"8.24":"82.47", linePrices: prices, quoteReason: "合成逐款报价", quotedBy: id(1), quotedAt: now },
  decision: { sourcingDecisionId: id(3), decisionVersion: 1, sourceType: "initial", sourceIeQuoteId: id(2), supersedesDecisionId: null, supplierId: id(4), supplierCode: "FAC-FIXTURE", supplierName: "合成加工厂", unitPrice: "4.1234", quantity: multiple?2:20, totalAmount: multiple?"8.24":"82.47", linePrices: prices, decisionReason: "合成批准事实", decidedBy: id(1), decidedAt: now },
  ownerDecision: { sourcingOwnerDecisionId: id(5), sourcingDecisionId: id(3), decision: "approved", decisionReason: "合成批准", decidedBy: id(1), decidedAt: now },
});
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
Object.assign(globalThis,{__r3TransferRequests:[]});
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method && init.method !== "GET") {
    (globalThis as unknown as {__r3TransferRequests:unknown[]}).__r3TransferRequests.push({path,body:JSON.parse(String(init.body))});
    return reply({ error: { message: "合成 UI 截取请求：未写入任何业务数据库" } }, 403);
  }
  if (path.includes("sourcing/styles") || path.includes("master-data/crafts")) return reply([]);
  if (path.endsWith("/attachments") || path.endsWith("/timeline")) return reply({items:[]});
  if (path.endsWith("/factories")) return reply({items:[{supplierId:id(40),supplierCode:"TEST-NEW",supplierName:"TEST 新厂"}]});
  if (path.endsWith("/contract-return")) return reply({contractReturnMonitoring:false,contractReturnStatus:null,contractGeneratedAt:null,contractReturnDueAt:null,contractReturnedAt:null,contractReturnOverdueHours:null,uploadedByName:null,canUpload:false,attachments:[]});
  if (path.endsWith("/dispatch")) return reply({ item: null, canDispatch: false });
  if (path.endsWith("/factory-changes/current")) return reply({item:null,remainingLines:prices.map(p=>({position:p.position,plannedQuantity:p.quantity,completedQuantity:0,quantity:p.quantity}))});
  if (path.endsWith("/contract")) return reply({item:null});
  if (path.includes("sourcing/cases?")) return reply({ items: [item], page: 1, pageSize: 15, totalCount: 1, totalPages: 1 });
  if (path.endsWith(`/cases/${id(100)}`)) return reply(item);
  return reply({ error: { message: "未配置的离线请求" } }, 404);
};
createRoot(document.getElementById("root")!).render(<SourcingWorkspacePage view="detail" sourcingCaseId={id(100)} />);
