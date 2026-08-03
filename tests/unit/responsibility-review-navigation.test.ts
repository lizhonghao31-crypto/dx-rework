import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const componentsUrl = new URL(
  "../../apps/web/src/components.tsx",
  import.meta.url,
);
const pagesUrl = new URL("../../apps/web/src/pages.tsx", import.meta.url);

describe("responsibility review navigation closure", () => {
  it("never navigates responsibility handling with a display rework number", async () => {
    const source = await readFile(componentsUrl, "utf8");
    expect(source).not.toMatch(/\/ui\/tasks\/RW-/);
    expect(source).toContain(
      "/ui/tasks?status=pending_responsibility_determination",
    );
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
