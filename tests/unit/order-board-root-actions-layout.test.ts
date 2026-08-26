import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board Root action layout", () => {
  it("keeps desktop correction actions in a compact dedicated rightmost column", async () => {
    const [page, styles] = await Promise.all([
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/web/src/order-board-page.css", "utf8"),
    ]);

    expect(page.indexOf("{rootControls(row, false)}")).toBeGreaterThan(
      page.indexOf("<span>收货人</span>"),
    );
    expect(styles).toContain("repeat(7,minmax(72px,1fr)) minmax(74px,auto)");
    expect(styles).toContain(".order-board-root-actions--desktop{justify-self:end;white-space:nowrap}");
    expect(styles).toContain(".order-board-root-actions--mobile{display:flex!important;grid-column:1/-1;justify-content:flex-end}");
  });
});
