import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board Root action layout", () => {
  it("keeps every desktop field isolated and places all actions in the rightmost column", async () => {
    const [page, styles] = await Promise.all([
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/web/src/order-board-page.css", "utf8"),
    ]);

    expect(page.indexOf("{actionControls(row, false)}")).toBeGreaterThan(
      page.indexOf("<span>收货人</span>"),
    );
    expect(page).not.toContain("{reworkControl(row, false)}");
    expect(page).toContain("const rework = reworkControl(row, mobile)");
    expect(styles).toContain("minmax(190px,auto)!important");
    expect(styles).toContain(".order-board-actions--desktop,.order-board-actions--desktop *{white-space:nowrap}");
  });

  it("uses four information columns and one compact action row on mobile", async () => {
    const styles = await readFile("apps/web/src/order-board-page.css", "utf8");

    expect(styles).toContain("grid-template-columns:repeat(4,minmax(0,1fr))!important");
    expect(styles).toContain(".order-board-row__latest{grid-column:span 2}");
    expect(styles).toContain(".order-board-actions--mobile{display:flex!important;grid-column:1/-1");
  });
});
