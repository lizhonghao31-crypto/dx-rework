// Isolated synthetic responses; this entry is never imported by the application.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PatternRoomOrderDetailPage } from "../../apps/web/src/pattern-room-orders-page.js";
import { PatternOrderForm } from "../../apps/web/src/pattern-order-form.js";
import { Header, NavigationGroupMenu } from "../../apps/web/src/components.js";
import { financeNavigationEntries } from "../../apps/web/src/finance-access.js";
import type { PatternOrderDetail } from "@dx-rework/contracts/pattern-orders";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/rework-detail-compact.css";
import "../../apps/web/src/ui-polish.css";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const time = "2026-09-16T08:00:00Z";
let kind: "pattern" | "misc" = "pattern";
let status: PatternOrderDetail["status"] = "pending_assignment";
let hourly: "configured" | "unconfigured" | "failed" | "delayed" = "configured";
let lastBody: Record<string, unknown> = {};
let sequence = 20;
const metadata = new Map<string, Record<string, unknown>>();
const order = (): PatternOrderDetail => ({
  orderId: id(1), orderNo: "BF-TEST-UX-001", kind, taskName: kind === "misc" ? "TEST 杂事资料整理" : null, status, version: 1,
  styleNo: "TEST 长款号和详细制作要求展示", creatorId: id(2), creatorName: "测试设计师", currentWorkerName: "测试师傅",
  requiredDate: String(lastBody.requiredDate ?? "2026-09-28"), reworkCount: 0, submittedAt: time, updatedAt: time,
  currentRoundId: id(3), customer: "测试客户", sizeColor: "M / 黑色", referenceStyleNo: "TEST-REF", variant: "初版", note: "仅供隔离验收，不连接业务系统。",
  rounds: [{ roundId: id(3), index: 0, roundType: "initial", requestedBy: id(2), requestReason: null, status, categoryName: "基础T恤/背心", unit: kind === "misc" ? "小时" : "件", quantity: 2,
    unitPrice: "15.000", agreedAmount: "30.000", assignedAt: null, completedAt: null, handedOverAt: null, stoppedAt: null, cancelledAt: null, feeConfirmedAt: null, segments: [],
    nodes: [{ stage: "pending_assignment", enteredAt: time, exitedAt: status === "pending_assignment" ? null : time, exitReason: status === "pending_assignment" ? null : "advanced", elapsedSeconds: 60 }] }],
  attachments: Array.from({ length: 6 }, (_, n) => ({ attachmentId: id(n + 10), roundId: id(3), filename: `TEST-制作资料-${n + 1}.pdf`, mimeType: "application/pdf", sizeBytes: 100, active: true, addedAt: time, reason: "测试" })),
  history: [], actions: { delete: false, assign: status === "pending_assignment", complete: status === "in_progress", handoff: status === "pending_confirmation", edit: true, hours: kind === "misc", rework: false, transfer: false, cancel: false, cancelFees: false },
});
window.fetch = async (input, init = {}) => {
  const path = String(input);
  if (path.includes("/upload-limits")) return Response.json({ maxUploadBytes: 20 * 1024 * 1024 });
  if (path.endsWith("/category-options")) return Response.json([{ priceId: id(4), name: "基础T恤/背心", unit: "件" }]);
  if (path.endsWith("/hourly-quote") || path.endsWith("/quote")) {
    if (hourly === "delayed") await new Promise(resolve => setTimeout(resolve, 1500));
    if (hourly === "failed") return Response.json({ error: { code: "UNAVAILABLE", message: "测试：价格读取失败" } }, { status: 503 });
    return Response.json({ priceId: id(4), name: "测试价", unit: kind === "misc" ? "小时" : "件", amount: hourly === "unconfigured" ? null : kind === "misc" ? "50.500" : "15.000", version: 1 });
  }
  if (path.includes("/workers?")) return Response.json([{ personId: id(5), userId: id(6), name: "测试师傅" }]);
  if (path.includes("/upload-intents")) {
    const attachmentId = id(++sequence); metadata.set(attachmentId, JSON.parse(String(init.body)));
    return Response.json({ attachmentId, objectKey: "synthetic", uploadMethod: "POST", uploadUrl: "https://fixture.invalid/upload", uploadFields: {}, expiresAt: time });
  }
  if (path === "https://fixture.invalid/upload") return new Response(null, { status: 204 });
  if (path.includes("/finalize")) {
    const attachmentId = path.split("/").at(-2)!;
    return Response.json({ attachmentId, ...metadata.get(attachmentId), status: "ready", createdAt: time });
  }
  if (/\/pattern-room\/(?:misc-)?orders(?:\/[^/?]+(?:\/materials|\/misc-materials)?)?$/.test(path)) {
    if (init.method === "POST") lastBody = JSON.parse(String(init.body));
    return Response.json(order());
  }
  throw new Error(`不在隔离样板请求白名单内：${path}`);
};

function Preview() {
  const [view, setView] = useState("detail"), [revision, setRevision] = useState(0), [saved, setSaved] = useState(false);
  const refresh = () => { setRevision(value => value + 1); setSaved(false); };
  const syntheticUpload = () => {
    const input = document.querySelector("input[type=file]") as HTMLInputElement | null;
    if (!input || input.disabled) return;
    const transfer = new DataTransfer(); transfer.items.add(new File(["%PDF-1.7\nTEST"], "TEST-新制作资料.pdf", { type: "application/pdf" }));
    input.files = transfer.files; input.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return <>
    <nav aria-label="隔离验收控制" style={{ padding: 8, display: "flex", flexWrap: "wrap", gap: 8 }}>
      <label>页面<select value={view} onChange={event => { setView(event.target.value); refresh(); }}><option value="detail">订单详情</option><option value="create">创建订单</option><option value="edit">更新资料</option><option value="finance">财务二级导航</option></select></label>
      <label>类型<select onChange={event => { kind = event.target.value as typeof kind; refresh(); }}><option value="pattern">打板</option><option value="misc">杂事</option></select></label>
      <label>状态<select onChange={event => { status = event.target.value as typeof status; refresh(); }}>{["pending_assignment", "in_progress", "pending_confirmation", "completed", "cancelled"].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>报价响应<select onChange={event => { hourly = event.target.value as typeof hourly; refresh(); }}>{["configured", "unconfigured", "failed", "delayed"].map(value => <option key={value}>{value}</option>)}</select></label>
      <button onClick={syntheticUpload}>选择一份合成 PDF</button>
    </nav>
    <main style={{ padding: "16px", maxWidth: "1080px", margin: "auto" }}>
      {view === "finance" ? <div style={{ background: "#111c25", padding: 16, maxWidth: 300 }}><NavigationGroupMenu active="工资管理" basePath="/rework" group={{ name: "财务中心", description: "财务资料与工资", entries: financeNavigationEntries({ id: id(7), displayName: "合成工资会计", businessRoles: ["wage_month_close_accountant"], capabilities: ["wage:view"] }) }} /></div>
        : view === "detail" ? <PatternRoomOrderDetailPage key={`${kind}:${status}:${revision}`} orderId={id(1)} /> : <div className="pattern-orders"><Header title={view === "create" ? "创建订单" : "更新资料"} badge="订单打板" backHref="/ui/pattern-room/orders" /><PatternOrderForm key={`${kind}:${view}:${revision}`} kind={kind} {...(view === "edit" ? { order: order() } : {})} onCancel={() => setView("detail")} onSaved={() => setSaved(true)} /></div>}
      {saved && <output aria-label="提交结果">保存成功；日期：{String(lastBody.requiredDate)}；附件：{(lastBody.attachmentIds as string[]).length}</output>}
    </main>
  </>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
