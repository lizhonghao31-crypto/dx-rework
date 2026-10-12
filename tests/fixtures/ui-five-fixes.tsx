// Actual application components, synthetic intercepted requests; no business service or database.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { DevelopmentCreateForm, type DevelopmentCreateIntent } from "../../apps/web/src/digital-development-create-form.js";
import { DigitalProductionPage } from "../../apps/web/src/digital-production-page.js";
import { Shell } from "../../apps/web/src/components.js";
import { ManagementOrderCard } from "../../apps/web/src/reporting/management-order-card.js";
import { BasicReworkBoard } from "../../apps/web/src/reporting/basic-rework-board.js";
import { Surface } from "@dx-rework/ui";
import type { OrderJourney } from "@dx-rework/contracts/digital-production-journey";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { initialDevelopmentDocument } from "../../apps/web/src/digital-development-editing.js";
import "../../packages/ui/src/tokens.css";
import "../../packages/ui/src/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/workflow-state-visual.css";
import "../../apps/web/src/ui-polish.css";
import "../../apps/web/src/unified-shell.css";
import "../../apps/web/src/digital-development-workspace.css";
import "../../apps/web/src/reporting/reporting.css";
import "../../apps/web/src/reporting/rework-query-mobile.css";

const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const params = new URLSearchParams(location.search), mode = params.get("mode") ?? "create";
const user = { id: id(3), displayName: "TEST 用户", isRoot: true, businessRoles: ["root_superuser"], capabilities: ["digital_production:view", "pattern_room:orders:create", "rework:basic:view"] };
const longStyle = "TEST-" + "长款号ABCDEFGHIJKLMNOPQRSTUVWXYZ".repeat(3);
const requests: { path: string; method: string; body: unknown }[] = [];
let saved = JSON.parse(sessionStorage.getItem("ui-five-synthetic-order") ?? "null");
Object.assign(window, { uiFiveRequests: requests, uiFiveSaved: saved, uiFiveCancelled: false, uiFiveRead: null });
const source = { sourceId: id(1), customer: "TEST", designStyleNo: "TEST-STYLE", temporaryStyleNo: "TEST-MOTHER-TEMP", designer: "TEST 设计师", selectedRound: 1 } as OrderJourney;
window.fetch = async (input, init) => {
  const path = String(input), method = init?.method ?? "GET", body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ path, method, body });
  if (method !== "GET") {
    if (params.has("slow")) await new Promise(resolve => setTimeout(resolve, 350));
    if (path.endsWith("/sources")) return Response.json({ sourceId: id(1) });
    if (path.endsWith(`/sources/${id(1)}/development`) && method === "PUT") return Response.json({ sourceId: id(1), version: 1, document: body.document });
    if (!path.endsWith(`/sources/${id(1)}/confirm`)) throw new Error("Unexpected synthetic mutation: " + path);
    const parsed = DigitalOrderCreateSchema.parse(body);
    saved = { ...parsed, productionOrderId: id(2), sourceId: id(1), createdBy: id(3), version: 1, createdAt: "2026-10-12T00:00:00Z", lines: parsed.lines.map((line, index) => ({ ...line, lineId: id(20 + index) })) };
    sessionStorage.setItem("ui-five-synthetic-order", JSON.stringify(saved));
    Reflect.set(window, "uiFiveSaved", saved);
    return Response.json(saved);
  }
  if (path.endsWith("auth/me")) return Response.json({ status: "authorized", user });
  if (path.endsWith("access/options")) return Response.json({ manage: true, customers: false, approveDelivery: false, create: true, actorId: id(3), roles: ["sample_designer"] });
  if (path.endsWith(`/orders/${id(2)}`)) { Reflect.set(window, "uiFiveRead", saved); return Response.json(saved); }
  if (path.endsWith(`/sources/${id(1)}/development`)) return Response.json({ sourceId: id(1), status: "draft", canEdit: true, version: 0, document: initialDevelopmentDocument() });
  if (path.includes("management/rework-basic-orders")) return Response.json({ canOpenOrder: true, page: 1, totalPages: 1, totalCount: 2, items: ["TEST-SHORT", longStyle].map((styleNo, index) => ({ reworkOrderId: id(5 + index), reworkNo: "RW-TEST", styleNo, orderNo: "TEST-PO", processingFactory: "TEST 本厂", merchandiser: "TEST 跟单", quantity: "10", reason: "TEST", problemPart: null, problemDescription: null, status: "pending_order_review", nodeLabel: "待尾部确认", photos: [] })) });
  return Response.json({ error: { message: "Unmapped synthetic read: " + path } }, { status: 404 });
};
function CreationFixture() {
  const [intent, setIntent] = useState<DevelopmentCreateIntent>((params.get("intent") as DevelopmentCreateIntent) ?? "confirm_order");
  return <Shell active="digital-designer"><DevelopmentCreateForm intent={intent} {...(intent === "confirm_order" ? { source } : {})} customers={[{ code: "TEST", name: "TEST 客户", productGroups: ["男装"], defaultMerchandiserId: null, defaultMerchandiserName: null }]} onIntentChange={setIntent} onCancel={() => { Reflect.set(window, "uiFiveCancelled", true); }} onCreated={() => { location.href = `/?mode=order&order=${id(2)}`; }} /></Shell>;
}
{
  const order = { reworkOrderId: id(5), reworkKind: "qc_rework" as const, reworkNo: "RW-TEST", styleNo: "TEST-SHORT", orderNo: "TEST", status: "pending_order_review" as const, node: "whole_order_review", nodeLabel: "待尾部确认", nodeEnteredAt: "2026-10-12T00:00:00Z", agingSeconds: 120, currentHandlerUserId: null, plannedQuantity: "10", reportedQuantity: "10", wageAmount: "2.00", responsibilityAmount: "2.00", ownFactoryAmount: "0.00", externalProposedAmount: "0.00", externalDeductedAmount: "0.00", externalRemainingAmount: "0.00", deductionStatus: "not_started" as const, overdue: false, exceptionCount: 0, attachmentCount: 0, deepLink: "/ui/tasks/TEST", updatedAt: "2026-10-12T00:00:00Z" };
  const content = mode === "order" ? <Shell active="digital-designer"><DigitalProductionPage /></Shell>
    : mode === "basic" ? <BasicReworkBoard />
    : mode === "cards" ? <Shell active="返工单看板"><div className="rework-query-content" data-legacy-ui="rework-board"><div className="reporting-order-grid"><ManagementOrderCard order={order} statusBesideStyle /><ManagementOrderCard order={{ ...order, reworkOrderId: id(6), styleNo: longStyle }} statusBesideStyle /></div></div></Shell>
    : mode === "dashboard" ? <Shell active="返工单看板"><ManagementOrderCard order={order} /></Shell>
    : mode === "unrelated" ? <Shell active="digital-designer"><Surface>TEST 其他页面</Surface></Shell>
    : <CreationFixture />;
  createRoot(document.getElementById("root")!).render(content);
}
