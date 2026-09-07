import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SourcingCaseSummarySchema } from "@dx-rework/contracts";
import { SourcingWorkspacePage } from "../../apps/web/src/sourcing-workspace-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-07T00:00:00.000Z";
const prices = [{ position: 1, quantity: 1000, unitPrice: "12.3000", totalAmount: "12300.00" }, { position: 2, quantity: 500, unitPrice: "18.5000", totalAmount: "9250.00" }];
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id(100), erpOrderId: "FIXTURE-100", erpOrderNo: "合成订单-100", styleNo: "DX-A", laneKey: "garment_processing",
  gender: "女装", styleName: "合成款式", orderQuantity: 1500,
  lineItems: prices.map((p, i) => ({ position: p.position, styleNo: i ? "DX-B" : "DX-A", alternateStyleNo: null, color: i ? "蓝色" : "白色", quantity: p.quantity, externalUnitPrice: p.unitPrice, legacy: false })),
  daxingUnitPrice: "20.0000", estimatedCutPieceSendDate: "2026-09-10", deliveryDate: "2026-09-15", processDescription: null, processes: ["合成缝制"],
  status: "pending_finance_reconciliation", version: 4, createdBy: id(1), createdAt: now, updatedAt: now,
  ieQuote: { sourcingIeQuoteId: id(2), quoteVersion: 1, unitPrice: "12.3000", quantity: 1500, totalAmount: "21550.00", linePrices: prices, quoteReason: "合成逐款报价", quotedBy: id(1), quotedAt: now },
  decision: { sourcingDecisionId: id(3), decisionVersion: 1, sourceType: "initial", sourceIeQuoteId: id(2), supersedesDecisionId: null, supplierId: id(4), supplierCode: "FAC-FIXTURE", supplierName: "合成加工厂", unitPrice: "12.3000", quantity: 1500, totalAmount: "21550.00", linePrices: prices, decisionReason: "合成批准事实", decidedBy: id(1), decidedAt: now },
  ownerDecision: { sourcingOwnerDecisionId: id(5), sourcingDecisionId: id(3), decision: "approved", decisionReason: "合成批准", decidedBy: id(1), decidedAt: now },
});
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method && init.method !== "GET") return reply({ error: { message: "离线回归禁止业务写入" } }, 403);
  if (path.includes("sourcing/styles") || path.includes("master-data/crafts")) return reply([]);
  if (path.endsWith("/attachments") || path.endsWith("/timeline") || path.endsWith("/factories")) return reply({ items: [] });
  if (path.endsWith("/dispatch")) return reply({ item: null, canDispatch: false });
  if (path.endsWith("/contract") || path.endsWith("/factory-changes/current")) return reply({ item: null });
  if (path.includes("sourcing/cases?")) return reply({ items: [item], page: 1, pageSize: 15, totalCount: 1, totalPages: 1 });
  if (path.endsWith(`/cases/${id(100)}`)) return reply(item);
  return reply({ error: { message: "未配置的离线请求" } }, 404);
};
function Fixture() {
  const [view, setView] = useState<"create" | "pending" | "detail">("create");
  return <main style={{ padding: 16 }}>
    <aside style={{ background: "white", padding: 12, marginBottom: 16 }} aria-label="离线测试控制">
      <b>外发数字事实 · 合成数据 · 禁止业务写入</b>
      <div><button onClick={() => setView("create")}>新建必填与数字</button><button onClick={() => setView("pending")}>多款摘要与删除确认</button><button onClick={() => setView("detail")}>财务逐款事实</button></div>
    </aside>
    <SourcingWorkspacePage key={view} view={view} sourcingCaseId={id(100)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
