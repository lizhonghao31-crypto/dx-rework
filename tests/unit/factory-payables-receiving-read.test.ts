// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { OrderBoardPage } from "../../apps/web/src/order-board-page.js";
import { Shell } from "../../apps/web/src/components.js";
import { ACCEPTANCE_ROLE_MATRIX } from "../../apps/web/src/acceptance-matrix.js";
import type * as AuthModule from "../../apps/web/src/auth.js";

// UI transport fixture only; real role grants, authentication, reads and denial are covered in PostgreSQL.
vi.mock("../../apps/web/src/auth.js", async importOriginal => ({
  ...await importOriginal<typeof AuthModule>(),
  verifySession: async () => ({ status: "authorized", user: { id: "TEST-accountant", displayName: "TEST 加工厂应付会计",
    businessRoles: ["factory_payables"], capabilities: ["tools:user", "sourcing:view", "supplier_profile:read", "external_responsibility:payables_confirm"] } }),
}));
let root: ReturnType<typeof createRoot> | undefined;
let host: HTMLDivElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); vi.unstubAllGlobals(); });

it("keeps the native receiving navigation, history and evidence available without rendering receiving mutations", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom does not implement native dialog methods; only model opening/closing, not authorization.
  HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  window.matchMedia = vi.fn().mockReturnValue({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  const row = { receivingBatchId: "TEST-batch", styleNo: "TEST-READ-ONLY", documentQuantity: 10, cumulativeActualQuantity: 8, cumulativeGoodQuantity: 7,
    actualQuantity: 8, defectiveQuantity: 1, differenceQuantity: -2, packingQuantity: null, packingDifferenceQuantity: null,
    actualCutCount: null, lastReceiverName: "TEST 仓管", lastReceivedAt: "2026-11-15T02:00:00Z",
    receiptCount: 2, attachments: [{ attachmentId: "TEST-image", filename: "TEST.jpg" }], receivingDifferenceResolution: null, packingDifferenceResolution: null,
    receivingHistory: [{ receiptId: "TEST-receipt", sequence: 1, receiptDocumentQuantity: 10, actualQuantity: 8, defectiveQuantity: 1,
      cumulativeActualQuantity: 8, differenceQuantity: -2, receiverName: "TEST 仓管", receivedAt: "2026-11-15T02:00:00Z" }],
    rootCorrectable: true, rootDeletable: true, rootMutable: true, version: 1 };
  const fetcher = vi.fn(async (...args: [RequestInfo | URL, RequestInit?]) => {
    if (args[1]?.method && args[1].method !== "GET") throw new Error("Read-only page attempted a write");
    return { ok: true, json: async () => ({ date: "2026-11-15", startDate: "2026-11-15", endDate: "2026-11-15", mode: "range", status: "all",
    kpis: { orderCount: 1, receivedQuantity: 8, abnormalOrderCount: 1, differenceQuantity: 2, differenceRate: 20 }, rows: [row], page: 1, pageSize: 15, totalCount: 1, totalPages: 1 }) };
  });
  vi.stubGlobal("fetch", fetcher);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(createElement(Shell, { active: "订单回货", children: createElement(OrderBoardPage) })));
  expect(host.querySelector('a[href$="/ui/orders"]')).not.toBeNull();
  expect(host.textContent).toContain("TEST-READ-ONLY");
  expect(host.textContent).toContain("正品数量7件");
  for (const text of ["仓库收货", "发起返工", "发起做尾", "导出", "去处理", "录入", "修改", "删除"]) {
    expect(Array.from(host.querySelectorAll("button,a")).some(element => element.textContent?.includes(text)), text).toBe(false);
  }
  await act(async () => host!.querySelector<HTMLButtonElement>(".order-board-history-toggle")!.click());
  expect(host.querySelector(".order-board-history")?.textContent).toContain("本次实收含次品数 8件");
  await act(async () => host!.querySelector<HTMLButtonElement>(".order-board-attachment-button")!.click());
  expect(host.querySelector('img[src*="TEST-image/download?mode=preview"]')).not.toBeNull();
  expect(fetcher.mock.calls.length).toBeGreaterThan(0);
  expect(fetcher.mock.calls.every(([, options]) => !options?.method || options.method === "GET")).toBe(true);
});

it("includes board read and explicit mutation/export denials in the approved role acceptance matrix", () => {
  const role = ACCEPTANCE_ROLE_MATRIX.find(entry => entry.expectedRole === "factory_payables")!;
  expect(role.probes?.find(probe => probe.id === "receiving-board")?.expectedStatus).toBe(200);
  for (const id of ["receiving-export", "receiving-create-options"]) expect(role.probes?.find(probe => probe.id === id)?.expectedStatus).toBe(403);
  for (const cap of ["receiving:create", "receiving:correct", "receiving:packing_manage", "receiving:resolve_difference", "receiving:export"]) {
    expect(role.forbiddenCapabilities).toContain(cap);
    expect(role.ruleRefs?.[`cap:${cap}:deny`]?.status).toBe("approved");
  }
});
