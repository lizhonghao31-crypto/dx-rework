import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SourcingCaseSummarySchema } from "@dx-rework/contracts";
import { SourcingWorkspacePage } from "../../apps/web/src/sourcing-workspace-page.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/ui-polish.css";
import "./sourcing-governed-preview.css";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const now = "2026-09-07T00:00:00.000Z";
const prices = Array.from({ length: 5 }, (_, i) => ({ position: i + 1, quantity: 1000, unitPrice: `${12 + i}.3000`, totalAmount: `${12300 + i * 1000}.00` }));
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id(100), erpOrderId: "FIXTURE-100", erpOrderNo: "合成订单-100", styleNo: "DX-A", laneKey: "garment_processing",
  gender: "女装", styleName: "合成款式", orderQuantity: 5000,
  lineItems: prices.map((p, i) => ({ position: p.position, styleNo: `DX-2026-秋季长款号-${i + 1}-SAMPLE`, alternateStyleNo: null, color: i ? "蓝色" : "白色", quantity: p.quantity, externalUnitPrice: p.unitPrice, legacy: false })),
  daxingUnitPrice: "20.0000", estimatedCutPieceSendDate: "2026-09-10", deliveryDate: "2026-09-15", processDescription: null, processes: ["合成缝制"],
  status: "pending_finance_reconciliation", version: 4, createdBy: id(1), createdAt: now, updatedAt: now,
  ieQuote: { sourcingIeQuoteId: id(2), quoteVersion: 1, unitPrice: "12.3000", quantity: 5000, totalAmount: "71500.00", linePrices: prices, quoteReason: "合成逐款报价", quotedBy: id(1), quotedAt: now },
  decision: { sourcingDecisionId: id(3), decisionVersion: 1, sourceType: "initial", sourceIeQuoteId: id(2), supersedesDecisionId: null, supplierId: id(4), supplierCode: "FAC-FIXTURE", supplierName: "合成·达兴服装加工合作工厂（秋季订单承接车间）", unitPrice: "12.3000", quantity: 5000, totalAmount: "71500.00", linePrices: prices, decisionReason: "合成批准事实", decidedBy: id(1), decidedAt: now },
  ownerDecision: { sourcingOwnerDecisionId: id(5), sourcingDecisionId: id(3), decision: "approved", decisionReason: "合成批准", decidedBy: id(1), decidedAt: now },
});
type Phase = "create" | "pending" | "ie" | "management" | "owner";
let phase: Phase = "owner";
let readonly = false;
let missingBudget = false;
let empty = false;
let failed = false;
const fixtureGlobal = globalThis as typeof globalThis & { __ui01User?: unknown; __ui01Image?: string };
fixtureGlobal.__ui01Image = "data:image/svg+xml," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180"><rect width="240" height="180" fill="#f2f5f8"/><path d="M85 35L105 25Q120 42 135 25L155 35L188 70L163 88L150 73V152H90V73L77 88L52 70Z" fill="#526371" stroke="#131c26" stroke-width="2"/><text x="120" y="172" text-anchor="middle" font-size="12">合成款式示意</text></svg>');
const setUser = () => { fixtureGlobal.__ui01User = readonly
  ? { id: id(1), isRoot: false, businessRoles: ["owner_group"], capabilities: [], readOnlyModules: ["sourcing"] }
  : { id: id(1), isRoot: true, businessRoles: [], capabilities: [] }; };
setUser();
const currentItem = () => {
  const current = { ...item, status: phase === "ie" ? "pending_ie_quote" : phase === "management" ? "pending_management_decision" : "pending_owner_approval",
    ieQuote: phase === "ie" ? null : item.ieQuote, decision: phase === "ie" || phase === "management" ? null : item.decision, ownerDecision: null };
  if (missingBudget) delete current.daxingUnitPrice;
  return current;
};
const reply = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const path = String(input);
  if (init?.method && init.method !== "GET") return reply({ error: { message: "这是隔离样板：已演示提交反馈，不写入业务数据。" } }, 403);
  if (failed) return reply({ error: { message: "合成加载失败，可切回正常场景重试" } }, 503);
  if (path.includes("sourcing/styles") || path.includes("master-data/crafts")) return reply([]);
  if (path.endsWith("/attachments")) return reply({ items: empty ? [] : Array.from({ length: 8 }, (_, i) => ({ attachmentId: id(200 + i), filename: `合成款式照片-${i + 1}.png`, mimeType: "image/png" })) });
  if (path.endsWith("/timeline") || path.endsWith("/factories")) return reply({ items: [] });
  if (path.endsWith("/dispatch")) return reply({ item: null, canDispatch: false });
  if (path.endsWith("/contract") || path.endsWith("/factory-changes/current")) return reply({ item: null });
  if (path.includes("sourcing/cases?")) return reply({ items: empty ? [] : [currentItem()], page: 1, pageSize: 15, totalCount: empty ? 0 : 1, totalPages: empty ? 0 : 1 });
  if (path.endsWith(`/cases/${id(100)}`)) return reply(currentItem());
  return reply({ error: { message: "未配置的离线请求" } }, 404);
};
function Fixture() {
  const [revision, setRevision] = useState(0);
  const reset = () => { setUser(); setRevision(value => value + 1); };
  return <main className="ui01-preview">
    <aside className="ui01-preview-controls" aria-label="样板控制">
      <strong>UI-01 外发视觉样板</strong><span>隔离合成数据 · 仅供视觉与交互确认</span>
      <nav>{([["create", "跟单创建"], ["pending", "订单列表"], ["ie", "IE 报价"], ["management", "生产选厂"], ["owner", "老板审批"]] as const).map(([value, label]) => <button key={value} aria-pressed={phase === value} onClick={() => { phase = value; reset(); }}>{label}</button>)}</nav>
      <label><input type="checkbox" checked={readonly} onChange={event => { readonly = event.target.checked; reset(); }} />只读岗位</label>
      <label><input type="checkbox" checked={missingBudget} onChange={event => { missingBudget = event.target.checked; reset(); }} />预算字段被裁剪</label>
      <label><input type="checkbox" checked={empty} onChange={event => { empty = event.target.checked; reset(); }} />空列表／无图片</label>
      <label><input type="checkbox" checked={failed} onChange={event => { failed = event.target.checked; reset(); }} />加载失败</label>
      <p>可切换页面、折叠历史／流程、滑动照片与表格、打开大图、点击提交查看隔离反馈。页面链接在样板中禁用，使用上方切换。</p>
    </aside>
    <SourcingWorkspacePage key={revision} view={phase === "create" ? "create" : phase === "pending" ? "pending" : "detail"} sourcingCaseId={id(100)} />
  </main>;
}
document.addEventListener("click", event => { if ((event.target as Element).closest("a")) event.preventDefault(); }, true);
createRoot(document.getElementById("root")!).render(<Fixture />);

