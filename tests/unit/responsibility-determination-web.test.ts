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
  it("uses one primary N08 submit action while retaining backend takeover and transfer compatibility", async () => {
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
      "pendingMutationKeys.current[signature] ?? crypto.randomUUID()",
    );
    expect(source).toContain('"idempotency-key": idempotencyKey');
    expect(source).toContain("提交老板签字");
    expect(source).not.toContain("请先保存草稿");
  });

  it("keeps N08 to one primary responsibility and carries a joint-responsibility record", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("primaryResponsibilityType");
    expect(source).toContain("setPrimaryResponsibility");
    expect(source).toContain('sharePercent: "100"');
    expect(source).toContain("共同责任记录 / 修改说明（可选）");
    expect(source).toContain("每道工序选择一个责任方");
    expect(source).toContain("外部扣款倍率（最低 1.2）");
  });

  it("does not hardcode or calculate responsibility money in the browser", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).not.toContain("154.55");
    expect(source).not.toContain("parseFloat(");
    expect(source).not.toContain("Number(process.multiplier");
    expect(source).not.toMatch(/responsibilityAmount\s*[/+*-]/);
    expect(source).toContain("process.baseAmount");
    expect(source).toContain("persistedPrimary?.multiplier");
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
    expect(source).toContain(".responsibility-allocations > div");
    expect(source).toContain("grid-template-columns: 1fr");
  });
});
