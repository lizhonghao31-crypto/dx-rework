import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const panelUrl = new URL(
  "../../apps/web/src/responsibility-determination-panel.tsx",
  import.meta.url,
);
const pagesUrl = new URL("../../apps/web/src/pages.tsx", import.meta.url);
const styleUrl = new URL(
  "../../apps/web/src/responsibility-determination.css",
  import.meta.url,
);

describe("responsibility determination web integration", () => {
  it("loads the live N07/N08 schemas and supplier plus owner-signature endpoints", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("ResponsibilityDeterminationResponseSchema");
    expect(source).toContain(
      "rework-orders/${reworkOrderId}/responsibility-determination",
    );
    expect(source).toContain("responsibility-determinations/drafts");
    expect(source).toContain("responsibility-determinations/finalize");
    expect(source).toContain("responsibility-determinations/transfer");
    expect(source).toContain("responsibility-determinations/takeover");
    expect(source).toContain("responsibility-determinations/supplier-options");
    expect(source).toContain("responsibility-owner-signature/${decision}");
    expect(source).toContain(
      "pendingMutationKeys.current[signature] ?? crypto.randomUUID()",
    );
    expect(source).toContain('"idempotency-key": idempotencyKey');
  });

  it("keeps N07 to one primary responsibility and carries a joint-responsibility record", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("primaryResponsibilityType");
    expect(source).toContain("setPrimaryResponsibility");
    expect(source).toContain('sharePercent: "100"');
    expect(source).toContain("共同责任记录 / 修改说明（可选）");
    expect(source).toContain("每道工序只选一个责任方");
    expect(source).toContain("外部扣款倍率（默认且最低 1.2）");
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
  });

  it("keeps the responsibility workspace usable on narrow screens", async () => {
    const source = await readFile(styleUrl, "utf8");
    expect(source).toContain("@media (max-width: 800px)");
    expect(source).toContain("@media (max-width: 480px)");
    expect(source).toContain(".responsibility-allocations > div");
    expect(source).toContain("grid-template-columns: 1fr");
  });
});
