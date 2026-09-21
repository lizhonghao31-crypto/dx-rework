import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SourcingCaseSummarySchema, type SourcingNodeHistory, type SourcingHistoryNode } from "@dx-rework/contracts";
import { SourcingNodeHistoryView } from "../../apps/web/src/sourcing-node-history-page.js";
vi.mock("../../apps/web/src/components.js", () => ({ Header: ({ title }: { title: string }) => createElement("h1", null, title) }));
const id = "00000000-0000-4000-8000-000000000001";
const at = "2026-09-21T01:00:00.000Z";
const item = SourcingCaseSummarySchema.parse({
  sourcingCaseId: id, erpOrderId: "HISTORY", erpOrderNo: "HISTORY", styleNo: "OLD-STYLE", laneKey: "garment_processing", orderQuantity: 120,
  lineItems: [{ position: 1, styleNo: "OLD-STYLE", alternateStyleNo: null, color: "蓝色", quantity: 120, externalUnitPrice: null, legacy: false }],
  estimatedCutPieceSendDate: "2026-10-01", deliveryDate: "2026-10-20", processDescription: null, processes: [],
  status: "pending_management_decision", version: 2, createdBy: id, createdAt: at, updatedAt: at,
  ieQuote: { sourcingIeQuoteId: id, quoteVersion: 1, unitPrice: "12.34", quantity: 120, totalAmount: "1480.80", linePrices: [{position: 1, quantity: 120, unitPrice: "12.34", totalAmount: "1480.80"}], quoteReason: "当时报价说明", quotedBy: id, quotedAt: at },
  decision: null, ownerDecision: null,
});
const history: SourcingNodeHistory = { item, node: "ie_quote", entry: { entryId: id, kind: "ie_quote", version: 1, handledBy: "IE同事", handledAt: at, reason: "当时报价说明", unitPrice: "12.34", totalAmount: "1480.80", supplierName: null, decision: null, contractReference: null, signedOn: null, quantity: 120, differenceFields: [], result: null, resolution: null }, versions: [], relatedEntries: [], attachments: [], notices: [], contractReference: null };
const render = (node: SourcingHistoryNode = "ie_quote") => renderToStaticMarkup(createElement(SourcingNodeHistoryView, {
  history: { ...history, node }, currentHref: "/current", nodeHref: key => `/history/${key}`, expanded: true, onToggle: () => {}, onImage: () => {},
}));
describe("historical sourcing node pages", () => {
  it("renders the full quote page with original line inputs, pictures, workflow and readonly reason", () => {
    const html = render();
    for (const text of ["订单图片", "订单流程", "款式明细", "OLD-STYLE", "当时报价说明", "逐款汇总", "返回当前节点", "1,480.8"]) expect(html).toContain(text);
    for (const input of html.match(/<input\b[^>]*>/g) ?? []) expect(input).toContain('readOnly=""');
    expect(html).toContain('<textarea readOnly="">当时报价说明</textarea>');
    expect(html).not.toContain("预算价");
  });
  it("retains rejected transfer audits outside the selected historical snapshot", () => {
    const html = renderToStaticMarkup(createElement(SourcingNodeHistoryView, {
      history: { ...history, node: "management", relatedEntries: [{ ...history.entry, kind: "factory_change_verification", decision: "rejected", reason: "交期不符合要求" }] },
      currentHref: "/current", nodeHref: key => `/history/${key}`, expanded: false, onToggle: () => {}, onImage: () => {},
    }));
    expect(html).toContain("订单转厂记录");
    expect(html).toContain("转厂审核 · 驳回");
    expect(html).toContain("交期不符合要求");
    expect(html).not.toContain("<form");
  });
  it.each(["created", "ie_quote", "management", "owner", "finance"] as const)("%s has no writable business controls", node => {
    const html = render(node);
    expect(html).not.toMatch(/type="(?:submit|file)"|<form\b/);
    for (const text of ["提交 IE", "提交调价", "同意并提交", "发起转厂", "补充图片", "保存草稿", "处理历史"]) expect(html).not.toContain(text);
  });
});
