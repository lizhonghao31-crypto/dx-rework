import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const panelUrl = new URL(
  "../../apps/web/src/responsibility-determination-panel.tsx",
  import.meta.url,
);
const routesUrl = new URL(
  "../../apps/api/src/rework/responsibility-determination-routes.ts",
  import.meta.url,
);
const pagesUrl = new URL("../../apps/web/src/pages.tsx", import.meta.url);
const styleUrl = new URL(
  "../../apps/web/src/responsibility-determination.css",
  import.meta.url,
);

describe("responsibility determination web integration", () => {
  it("uses one N09 submit action while retaining backend takeover and transfer compatibility", async () => {
    const [source, routes] = await Promise.all([
      readFile(panelUrl, "utf8"),
      readFile(routesUrl, "utf8"),
    ]);
    expect(source).toContain("ResponsibilityDeterminationResponseSchema");
    expect(source).toContain(
      "rework-orders/${reworkOrderId}/responsibility-determination",
    );
    expect(source).toContain("responsibility-determinations/drafts");
    expect(source).toContain("responsibility-determinations/finalize");
    expect(source).toContain("responsibility-determinations/takeover");
    expect(source).not.toContain("responsibility-determinations/transfer`");
    expect(routes).toContain("responsibility-determinations/transfer");
    expect(source).toContain("responsibility-determinations/supplier-options");
    expect(source).toContain("responsibility-owner-signature/${decision}");
    expect(source).toContain(
      "pendingMutationKeys.current[signature] ?? createClientRequestId()",
    );
    expect(source).toContain('"idempotency-key": idempotencyKey');
    expect(source).toContain("提交责任判定");
    expect(source).not.toContain("请先保存草稿");
  });

  it("supports multiple responsibility parties whose shares total 100 percent", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("addAllocation");
    expect(source).toContain("removeAllocation");
    expect(source).toContain("+ 添加责任方");
    expect(source).toContain("比例合计必须为 100%");
    expect(source).toContain("共同责任记录 / 修改说明（可选）");
    expect(source).toContain("每道工序可添加多个责任方");
    expect(source).toContain("扣款倍率（最低 1.2）");
  });

  it("batch-applies one responsibility to selected worker processes before the existing submit", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("selectedProcessIds");
    expect(source).toContain("batchAllocations");
    expect(source).toContain("批量判责");
    expect(source).toContain("确认覆盖并应用");
    expect(source).toContain("完整责任配置");
    expect(source).toContain("仍需点击“提交责任判定”才会保存");
    expect(source).toContain('process.executionKind === "worker"');
  });

  it("keeps the batch dialog keyboard-contained and restores focus", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("batchDialogRef");
    expect(source).toContain("batchReturnFocusRef");
    expect(source).toContain('event.key === "Escape"');
    expect(source).toContain('event.key !== "Tab"');
    expect(source).toContain("batchReturnFocusRef.current?.focus()");
  });

  it("treats the N01 tail bearer as an initial judgment that N07 confirms or explicitly changes", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("质检初判");
    expect(source).toContain("生产主管复核");
    expect(source).toContain("修改承担方");
    expect(source).toContain("历史系统默认（非质检判断）");
    expect(source).toContain("历史订单未记录质检判断");
    expect(source).toContain('response.tailInspectionCostBearerSource === "legacy_default"');
    expect(source).not.toContain("<legend>谁承担整查费用？</legend>");
  });

  it("does not hardcode responsibility money and labels the browser value as an estimate", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).not.toContain("154.55");
    expect(source).not.toContain("parseFloat(");
    expect(source).not.toContain("Number(process.multiplier");
    expect(source).not.toMatch(/responsibilityAmount\s*[/+*-]/);
    expect(source).toContain("process.baseAmount");
    expect(source).toContain("estimatedAllocationAmount");
    expect(source).toContain("persistedAllocation.roundedAmount");
  });

  it("uses the real task URL UUID and permission fields for actions", async () => {
    const [panel, pages] = await Promise.all([
      readFile(panelUrl, "utf8"),
      readFile(pagesUrl, "utf8"),
    ]);
    expect(pages).toContain("detailOrderId");
    expect(pages).toContain(
      "<ResponsibilityDeterminationPanel reworkOrderId={reworkOrderId} />",
    );
    expect(panel).toContain("response.canDetermine");
    expect(panel).toContain("response?.canTakeover");
    expect(panel).toContain("response?.canOwnerSign");
    expect(panel).toContain("requestCurrentUserId");
  });

  it("keeps the responsibility workspace usable on narrow screens", async () => {
    const source = await readFile(styleUrl, "utf8");
    expect(source).toContain("@media (max-width: 800px)");
    expect(source).toContain("@media (max-width: 480px)");
    expect(source).toContain(".responsibility-party");
    expect(source).toContain(".responsibility-batch-dialog");
    expect(source).toContain("grid-template-columns: 1fr");
  });
});
