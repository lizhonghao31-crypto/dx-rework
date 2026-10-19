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
  history: { ...history, node }, currentHref: "/current", nodeHref: key => `/history/${key}`, onImage: () => {},
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
      currentHref: "/current", nodeHref: key => `/history/${key}`, onImage: () => {},
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
  it("keeps independent customer and effective factory dates from the selected historical snapshot", () => {
    const html = renderToStaticMarkup(createElement(SourcingNodeHistoryView, {
      history: { ...history, item: { ...item, merchandiserName:"当时跟单", lineItems:[{...item.lineItems[0]!,lineId:id,customerWarehouseArrivalDate:"2026-10-03",factoryDeliveryDate:null,proposedFactoryDeliveryDate:"2026-11-19"}] } },
      currentHref:"/current", nodeHref:key=>`/history/${key}`, onImage:()=>{},
    }));
    const facts = html.match(/<dl[^>]*sourcing-key-facts[\s\S]*?<\/dl>/)?.[0] ?? "";
    expect(facts).toContain("当时跟单");
    expect(facts).toMatch(/<dt>PO \/ [^<]+<\/dt><dd>[\s\S]*?2026-10-03/);
    expect(facts).toMatch(/<dt>加工厂交货日<\/dt><dd>有 PO 日期待补（1\/1）/);
    expect(facts).toContain('当时要求交货：<span class="sourcing-date-token">2026-10-20</span>');
    expect(facts).not.toContain("2026-11-19");
  });
  it("does not describe unavailable historical customer dates as PO dates awaiting entry", () => {
    const historicalLine = { ...item.lineItems[0]!, lineId:id, factoryDeliveryDate:"2026-10-19" };
    expect(Object.hasOwn(historicalLine, "customerWarehouseArrivalDate")).toBe(false);
    const html = renderToStaticMarkup(createElement(SourcingNodeHistoryView, {
      history:{...history,item:{...item,lineItems:[historicalLine]}}, currentHref:"/current",nodeHref:key=>`/history/${key}`,onImage:()=>{},
    }));
    const customer = html.match(/<dt>PO \/ [^<]+<\/dt><dd>([\s\S]*?)<\/dd>/)?.[1];
    expect(customer).toBe("当时日期不详");
    expect(customer).not.toContain("待补");
    expect(html).toContain('2026-10-19');
  });
});
