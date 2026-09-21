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
let phase: "create" | "ie" | "management" = "create";
let outcome = "success";
let lost = false;
let records: { key: string; body: string; path: string }[] = [];
let publish = () => {};
let committed = false;
const currentItem = () => ({ ...item,
  status: phase === "ie" ? (committed ? "pending_management_decision" : "pending_ie_quote") : "pending_management_decision",
  processes: ["合成缝制"],
  ieQuote: phase === "ie" && !committed ? null : item.ieQuote,
  decision: null, ownerDecision: null,
});
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method && init.method !== "GET") {
    const headers = new Headers(init.headers);
    records.push({ path, key: headers.get("idempotency-key") ?? "", body: String(init.body) }); publish();
    if (outcome === "403" || outcome === "409") return reply({ error: { message: outcome === "403" ? "当前账号已撤权" : "订单已由他人办理，请刷新查看" } }, Number(outcome));
    if (path.includes("crafts/ensure")) return reply([{ craftId: id(90), craftCode: "TEST", craftName: "合成缝制", enabled: true }]);
    if (outcome === "lost" && !lost) { lost = true; committed = true; throw new TypeError("synthetic response lost after commit"); }
    committed = true;
    return reply(currentItem());
  }
  if (path.includes("sourcing/styles") || path.includes("master-data/crafts")) return reply([]);
  if (path.endsWith("/attachments") || path.endsWith("/timeline")) return reply({ items: [] });
  if (path.endsWith("/factories")) return reply({ items: [] });
  if (path.endsWith("/dispatch")) return reply({ item: null, canDispatch: false });
  if (path.endsWith("/contract") || path.endsWith("/factory-changes/current")) return reply({ item: null });
  if (path.endsWith(`/cases/${id(100)}`)) return reply(currentItem());
  return reply({ error: { message: "离线页面禁止访问真实接口" } }, 404);
};
function Fixture() {
  const [revision, setRevision] = useState(0);
  const [, setRequests] = useState(0);
  publish = () => setRequests(n => n + 1);
  const reset = (next: typeof phase) => { phase = next; committed = false; lost = false; records = []; setRevision(n => n + 1); };
  return <main style={{ padding: 16 }}>
    <aside style={{ background: "white", padding: 12, marginBottom: 16 }} aria-label="离线测试控制">
      <b>UX-01 合成数据回归；所有请求均在页面内模拟，不接触生产</b>
      <div><button onClick={() => reset("create")}>创建订单</button><button onClick={() => reset("ie")}>IE 报价</button><button onClick={() => reset("management")}>生产管理</button></div>
      <label>模拟提交结果<select aria-label="模拟提交结果" defaultValue="success" onChange={event => { outcome = event.target.value; }}>
        <option value="success">成功</option><option value="403">403 撤权</option><option value="409">409 冲突</option><option value="lost">写入成功但响应丢失</option>
      </select></label>
      <p role="status">业务请求数：{records.length}；复用同一请求：{records.length > 1 && records.every(row => row.key === records[0]?.key && row.body === records[0]?.body) ? "是" : "待验证"}</p>
      <pre aria-label="合成请求记录" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(records)}</pre>
    </aside>
    <SourcingWorkspacePage key={revision} view={phase === "create" ? "create" : "detail"} sourcingCaseId={id(100)} />
  </main>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
