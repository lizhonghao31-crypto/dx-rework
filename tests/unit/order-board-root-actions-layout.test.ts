import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board Root action layout", () => {
  it("places rework beside the style label and keeps Root actions in the rightmost column", async () => {
    const [page, styles] = await Promise.all([
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/web/src/order-board-page.css", "utf8"),
    ]);

    expect(page).toContain(
      '<div className="order-board-row__style-heading"><span>款号</span>{reworkControl(row)}</div>',
    );
    expect(page.indexOf("{actionControls(row, false)}")).toBeGreaterThan(
      page.indexOf("<span>收货人</span>"),
    );
    expect(page).toContain("const root = rootControls(row, mobile)");
    expect(page).not.toContain("const rework = reworkControl(row, mobile)");
    expect(styles).toContain(
      ".order-board-row__style-heading>span,.order-board-row__style-heading>.order-board-rework-link{font-size:10px",
    );
    expect(styles).toContain("minmax(86px,auto)!important");
  });

  it("uses three information columns and an inline rework entry on mobile", async () => {
    const styles = await readFile("apps/web/src/order-board-page.css", "utf8");

    expect(styles).toContain("grid-template-columns:repeat(3,minmax(0,1fr))!important");
    expect(styles).toContain(".order-board-actions--mobile{grid-column:1/-1;justify-content:flex-end}");
    expect(styles).toContain(
      ".order-board-row__style-heading>.order-board-rework-link{display:inline-flex!important",
    );
    expect(styles).toContain(".order-board-history__entry{grid-template-columns:repeat(2,minmax(0,1fr))");
  });
});
