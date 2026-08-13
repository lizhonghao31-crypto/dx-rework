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

  it("treats an empty responsibility share as zero without masking malformed input", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain('if (value === "") return 0n;');
    expect(source).toContain("const shareTotalBps = (");
    expect(source).toContain("if (shareTotalBps(process.allocations) !== 10000n) return false;");
    expect(source).toContain("const total = shareTotalBps(process.allocations);");
    expect(source).toContain('total === null ? "输入有误"');
    expect(source).toContain(
      '?.shareBps ?? (current ? 0 : value === "own_factory" ? 10000 : 0)',
    );
    expect(source).toContain(
      "allocation.shareBps !== null && allocation.shareBps > 0n",
    );
  });

  it("does not hardcode or calculate responsibility money in the browser", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).not.toContain("154.55");
    expect(source).not.toContain("parseFloat(");
    expect(source).not.toContain("Number(process.multiplier");
    expect(source).not.toMatch(/responsibilityAmount\s*[/+*-]/);
    expect(source).toContain("persisted.responsibilityAmount");
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
  });

  it("keeps the responsibility workspace usable on narrow screens", async () => {
    const source = await readFile(styleUrl, "utf8");
    expect(source).toContain("@media (max-width: 800px)");
    expect(source).toContain("@media (max-width: 480px)");
    expect(source).toContain(".responsibility-allocations > div");
    expect(source).toContain("grid-template-columns: 1fr");
  });
});
