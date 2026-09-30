import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const appUrl = new URL("../../apps/web/src/App.tsx", import.meta.url);
const componentsUrl = new URL(
  "../../apps/web/src/components.tsx",
  import.meta.url,
);
const pagesUrl = new URL("../../apps/web/src/pages.tsx", import.meta.url);
const queueUrl = new URL(
  "../../apps/web/src/responsibility-queue-page.tsx",
  import.meta.url,
);

describe("responsibility review navigation closure", () => {
  it("keeps the live responsibility queue as a route, not a global navigation item", async () => {
    const [app, components] = await Promise.all([
      readFile(appUrl, "utf8"),
      readFile(componentsUrl, "utf8"),
    ]);
    expect(components).not.toMatch(/\/ui\/tasks\/RW-/);
    expect(components).not.toContain(
      "/ui/tasks?status=pending_responsibility_determination",
    );
    expect(components).not.toContain('name: "责任处理"');
    expect(app).toContain('path === "/ui/responsibility"');
    expect(app).toContain("<ResponsibilityQueuePage />");
  });

  it("loads authorized queue data and links every item by real UUID", async () => {
    const source = await readFile(queueUrl, "utf8");
    expect(source).toContain("ResponsibilityQueueResponseSchema");
    expect(source).toContain('apiUrl("responsibility-determinations/queue")');
    expect(source).toContain("item.reworkOrderId");
    expect(source).toContain(
      "href={`${basePath}/ui/tasks/${item.reworkOrderId}`}",
    );
    expect(source).not.toContain("RW-2026-0728-003");
  });

  it("opens the live responsibility workspace only for a concrete UUID", async () => {
    const source = await readFile(pagesUrl, "utf8");
    expect(source).toContain("detailOrderId");
    expect(source).toContain("^\\/ui\\/tasks\\/([0-9a-f]");
    expect(source).toContain(
      "<ResponsibilityDeterminationPanel reworkOrderId={reworkOrderId} />",
    );
  });
});
