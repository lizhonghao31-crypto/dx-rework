// Offline visual fixture only. This entry is excluded from the production web build.
import React from "react";
import { createRoot } from "react-dom/client";
import { SampleWorkspacePage, type SamplePageMode } from "../../apps/web/src/sample-workspace-page.js";
import type { SampleView } from "../../packages/contracts/src/samples.js";
import "@dx-rework/ui/tokens.css";
import "@dx-rework/ui/components.css";
import "../../apps/web/src/styles.css";
import "../../apps/web/src/workflow-shell.css";
import "../../apps/web/src/dialog-visual-system.css";
import "../../apps/web/src/workflow-state-visual.css";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const role = document.body.dataset.role ?? "sample_designer";
const financial = ["sample_finance", "owner_group", "root_superuser"].includes(role);
const capabilities = ["sample:view_basic", "todo:view", ...(financial ? ["sample:view_finance", "sample:view_audit"] : role === "sample_administrative" ? ["sample:view_audit"] : [])];
const rows: SampleView[] = Array.from({ length: 47 }, (_, n) => ({
  sampleId: id(n + 1), sampleCode: `YI-202609-${String(n + 1).padStart(4, "0")}`, status: n < 31 ? "borrowed" : n < 40 ? "in_stock" : n < 44 ? "return_pending" : "sold", version: 1,
  brand: "测试品牌", styleName: "秋季开发样衣", styleNo: `TEST-${n + 1}`, category: "外套", color: "深蓝", size: "M",
  department: "设计一部", purchaseDate: "2026-09-01", purchaserUserId: id(100), purchaserName: "测试采购人",
  holderUserId: n < 31 || (n >= 40 && n < 44) ? id(100) : null, holderName: n < 31 || (n >= 40 && n < 44) ? "测试持有人" : null,
  purpose: "采购后直接开发/打板", borrowedAt: "2026-09-01T01:00:00Z", storageLocation: n >= 31 && n < 40 ? "样衣仓 A-01" : null,
  remark: "固定验收数据", createdAt: "2026-09-01T01:00:00Z", updatedAt: "2026-09-01T01:00:00Z",
  ...(financial ? { finance: { purchasePrice: "100.01", receiptAttachmentIds: [] } } : {}),
}));
globalThis.fetch = async input => {
  const url = new URL(String(input), "https://sample-fixture.invalid"), path = url.pathname;
  let body: unknown;
  if (path.endsWith("/auth/me")) body = { status: "authorized", user: { id: id(100), displayName: "样衣验收用户", businessRoles: [role], capabilities, isRoot: role === "root_superuser" } };
  else if (path.endsWith("/todos/mine/indicator")) body = { pendingCount: 4 };
  else if (path.endsWith("/samples/options")) body = { brands: ["测试品牌"], departments: ["设计一部"], purchaseYears: [2026], people: [{ userId: id(100), name: "测试持有人" }] };
  else if (path.endsWith("/samples/amounts")) body = { purchaseTotal: "4700.47", managedOriginalValue: "4400.44", disposedOriginalValue: "300.03", saleReceipts: "150.03", lossCompensation: "0.00" };
  else if (path.endsWith("/history")) body = { items: [{ id: id(200), occurredAt: "2026-09-01T01:00:00Z", actorName: "测试持有人", kind: "initial_custody", purpose: "采购后直接开发/打板", returnedAt: null }], page: 1, totalCount: 1 };
  else if (path.endsWith("/samples")) {
    const page = Number(url.searchParams.get("page") ?? 1), view = url.searchParams.get("view") ?? "borrowed", search = url.searchParams.get("search");
    const matching = rows.filter(row => (view === "managed" ? row.status !== "sold" : view === "pending" ? row.status.endsWith("pending") : view === "disposed" ? row.status === "sold" : row.status === view)
      && (!search || row.sampleCode.toUpperCase().startsWith(search.toUpperCase()) || row.styleNo.toUpperCase().startsWith(search.toUpperCase())));
    body = { items: matching.slice((page - 1) * 15, page * 15), totalCount: matching.length, page, counts: { borrowed: 31, inStock: 9, pending: 4 } };
  } else if (/\/samples\/[0-9a-f-]{36}$/.test(path)) body = { item: rows[0], canViewAudit: capabilities.includes("sample:view_audit") };
  else return new Response(JSON.stringify({ error: { message: "该路径不在离线验收范围" } }), { status: 404 });
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
};
createRoot(document.getElementById("root")!).render(<SampleWorkspacePage mode={(document.body.dataset.mode ?? "managed") as SamplePageMode} sampleId={id(1)} />);
