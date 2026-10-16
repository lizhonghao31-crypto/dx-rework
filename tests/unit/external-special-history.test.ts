import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ExternalResponsibilityCaseResponse } from "@dx-rework/contracts/external-responsibility";
import { deductionDifferenceLabel, ExternalSpecialHistory } from "../../apps/web/src/external-special-history.js";

type Request = NonNullable<ExternalResponsibilityCaseResponse["specialApproval"]>;
const request = (version: number, decision: "approved" | "returned" | null, reason: string | null = "数据有误"): Request => ({
  requestId: `request-${version}`, requestVersion: version, reason: "少扣差额本厂承担", attachmentIds: [],
  proposedAmount: "570.24", actualDeductedAmount: "0.00", remainingAmount: "570.24",
  requestMode: "proposed_entry", requestedAmount: "379.20", requestedBy: "user", requestedAt: "2026-10-16T07:16:27.969Z",
  decision: decision ? { decision, reason, decidedBy: "director", decidedAt: "2026-10-16T08:05:10.305Z" } : null,
});
const render = (latest: Request | null, history?: Request[], status = "pending_special_approval") => renderToStaticMarkup(createElement(ExternalSpecialHistory, { caseItem: {
  specialApproval: latest, specialApprovalHistory: history, status, actualDeductedAmount: "379.20",
} as ExternalResponsibilityCaseResponse }));

describe("special approval current result and collapsed history", () => {
  it("separates identical-amount rounds and keeps historical return inside closed details", () => {
    const html = render(request(2, "approved"), [request(1, "returned"), request(2, "approved")], "closed");
    const [current, history] = html.split('<details class="external-special-older">');
    expect(current).toContain("最新特批 · 第 2 轮");
    expect(current).toContain("已批准");
    expect(current).not.toContain("已退回");
    expect(current).not.toContain("申请金额");
    expect(history).toContain("第 1 轮");
    expect(history).toContain("退回原因");
    expect(history).toContain("数据有误");
    expect(html).not.toContain("<details open");
    expect(html.match(/第 2 轮/g)).toHaveLength(1);
    expect(html).toContain("2026/10/16 16:05");
  });
  it("shows pending, returned and approved latest results without inventing missing reasons", () => {
    expect(render(request(1, null))).toContain("待财务总监审批");
    expect(render(request(1, "returned", "  "))).toContain("未记录退回原因");
    expect(render(request(1, "approved", null))).not.toContain("批准说明");
    const long = "补充正确数据与凭证。".repeat(100);
    const html = render(request(1, "returned", long));
    expect(html).toContain(long);
    expect(html).toContain("展开全文");
    expect(html).toContain('<details class="external-special-explanation">');
  });
  it("preserves closed balance direction and frozen historical monetary context", () => {
    expect(deductionDifferenceLabel("-0.56", true)).toBe("结案超扣");
    expect(deductionDifferenceLabel("191.04", true)).toBe("结案少扣");
    expect(deductionDifferenceLabel("0.00", true)).toBe("结案差额");
    expect(deductionDifferenceLabel("-0.56", false)).toBe("超出拟扣");
    const previous = { ...request(1, "returned"), actualDeductedAmount: "80.00" };
    expect(render(request(2, "approved"), [previous])).toContain("459.2");
    const legacy = { ...previous, requestMode: undefined, remainingAmount: "-0.56" };
    const html = render(request(2, "approved"), [legacy]);
    expect(html).toContain("申请时超扣");
    expect(html).toContain("0.56");
    expect(render(request(2, "approved"), [{...legacy, remainingAmount:"68.10"}])).toContain("申请时未扣差额");
    expect(render(request(2, "approved"), [request(1, "returned")])).toContain("申请时尚未扣款");
  });
  it("supports single, legacy and absent histories without an empty disclosure", () => {
    expect(render(request(1, null))).not.toContain("<details");
    expect(render(request(1, null), [])).toContain("第 1 轮");
    expect(render(null, [request(1, "returned")])).toContain("已退回");
    expect(render(null)).toBe("");
  });
});
