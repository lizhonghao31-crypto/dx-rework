import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing role-aware transfer UI", () => {
  it("keeps five main nodes and exposes transfer for the three authorized roles on the current page", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain('{ key: "finance", number: "05", label: "财务核对", role: "财务" }');
    expect(page).not.toContain('{ key: "contract"');
    expect(page).toContain('canMerchandiserTransfer ? "order_merchandiser" : null');
    expect(page).toContain('selectedNode === "management"');
    expect(page).toContain('selectedNode === "owner"');
    expect(page).toContain('canOwnerTransfer ? "owner_group"');
    expect(page).toContain("供应链总监首次提交加工厂和单价后开放");
    expect(page).not.toContain("订单已完成归档，转厂入口已关闭");
    expect(page).toContain('factoryChange?.status === "pending_owner" ? Math.max(mainStep, 3)');
  });

  it("routes the three initiators and two approvers to the role-aware backend endpoints", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain("factory-changes/current");
    expect(page).toContain("factory-changes/management");
    expect(page).toContain("factory-changes/owner");
    expect(page).toContain('factory-changes/${factoryChange.factoryChangeRequestId}/decision');
    expect(page).toContain('factory-changes/${factoryChange.factoryChangeRequestId}/owner-decision');
    expect(page).toContain("订单转厂正在审批，财务核对已暂停");
  });

  it("keeps finance read-only, owner decisions concise and future nodes unavailable", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    expect(page).toContain("财务在付款、对账时核对系统信息");
    expect(page).toContain("核对不影响跟单派单和生产");
    expect(page).toContain("加工厂、单价、数量及总额只读");
    expect(page).toContain("财务不能在此页改写业务数据");
    expect(page).toContain("sourcing-owner-decision__lead");
    expect(page).not.toContain('className="sourcing-owner-summary"');
    expect(page).toContain('state === "future"');
    expect(page).toContain('aria-disabled="true"');
    expect(page).toContain("requestedNodeIsAccessible");
  });

  it("normalizes monetary inputs and preserves the responsive mobile boundary", async () => {
    const [page, css] = await Promise.all([
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("apps/web/src/sourcing-workspace.css", "utf8"),
    ]);
    expect(page).toContain("detail.decision?.linePrices.find");
    expect(page).toContain("detail.ieQuote?.linePrices.find");
    expect(page).toContain("linesTotalPreview(decision.linePrices, item.lineItems)");
    expect(page).toContain("factoryChangeUnitPriceEdited");
    expect(page).toContain("supplierId: current.supplierId");
    expect(page).toContain("changeReason: current.changeReason");
    expect(page).toContain("resetFactoryChange = false");
    expect(page).toContain("if (resetFactoryChange) {");
    expect(page).toContain('supplierId: ""');
    expect(page).toContain('changeReason: ""');
    expect(page).toContain('setFactoryChangeReviewReason("");');
    expect(page).toContain('"转厂申请已提交", true');
    expect(page).toContain("formatBusinessCurrency(factoryChange.proposedUnitPrice)");
    expect(page).not.toContain("isMobileClient");
    expect(page).not.toContain("该模块当前仅开放电脑端");
    expect(css).toContain("@media (max-width: 800px)");
    expect(css).toContain(".sourcing-factory-change__review > div");
    expect(css).toContain(".sourcing-factory-change__review input");
    expect(css).toContain(".sourcing-order-detail .rework-workflow__node.is-future");
  });
});
