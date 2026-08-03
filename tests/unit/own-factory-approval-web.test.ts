import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const panelUrl = new URL(
  "../../apps/web/src/own-factory-approval-panel.tsx",
  import.meta.url,
);
const queueUrl = new URL(
  "../../apps/web/src/own-factory-approval-queue-page.tsx",
  import.meta.url,
);
const appUrl = new URL("../../apps/web/src/App.tsx", import.meta.url);
const pagesUrl = new URL("../../apps/web/src/pages.tsx", import.meta.url);
const styleUrl = new URL(
  "../../apps/web/src/own-factory-approval.css",
  import.meta.url,
);

describe("own-factory approval web integration", () => {
  it("uses server snapshots, exact versions, and idempotency instead of browser money calculations", async () => {
    const source = await readFile(panelUrl, "utf8");
    expect(source).toContain("OwnFactoryApprovalResponseSchema");
    expect(source).toContain("own-factory-approval");
    expect(source).toContain("expectedOrderVersion");
    expect(source).toContain("expectedApprovalVersion");
    expect(source).toContain('"idempotency-key": crypto.randomUUID()');
    expect(source).toContain("sourceSnapshot.processes");
    expect(source).toContain("sourceSnapshot.amountLines");
    expect(source).not.toContain("parseFloat(");
    expect(source).not.toMatch(/ownFactoryTotalAmount\s*[/+*-]/);
  });

  it("adds a live N08-A queue and injects the permission-safe panel into the real order detail", async () => {
    const [queue, app, pages] = await Promise.all([
      readFile(queueUrl, "utf8"),
      readFile(appUrl, "utf8"),
      readFile(pagesUrl, "utf8"),
    ]);
    expect(queue).toContain('apiUrl("own-factory-approvals/queue")');
    expect(queue).toContain("item.reworkOrderId");
    expect(app).toContain('path === "/ui/own-factory-approvals"');
    expect(pages).toContain("<OwnFactoryApprovalPanel reworkOrderId={reworkOrderId} />");
  });

  it("keeps the approval detail usable on 390 and 360 width mobile screens", async () => {
    const style = await readFile(styleUrl, "utf8");
    expect(style).toContain("@media (max-width: 800px)");
    expect(style).toContain("@media (max-width: 480px)");
    expect(style).toContain("grid-template-columns: 1fr");
    expect(style).toContain("min-width: 0");
  });
});
