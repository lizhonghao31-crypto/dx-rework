import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("mobile operation controls", () => {
  it("lets shared fields shrink on every phone-sized viewport", async () => {
    const styles = await readFile("packages/ui/src/components.css", "utf8");

    expect(styles).toContain("@media (max-width: 800px)");
    expect(styles).toContain(".dx-field { min-width: 0; }");
  });

  it("keeps the approved mobile filters readable with a full-width search and expandable fields", async () => {
    const styles = await readFile("apps/web/src/reporting/rework-query-mobile.css", "utf8");

    expect(styles).toContain("@media(max-width:760px)");
    expect(styles).toContain("grid-template-columns:repeat(3,minmax(0,1fr))");
    expect(styles).toContain(".reporting-filters--orders :is(select,input,.dx-field__control,button)");
    expect(styles).toContain("min-height:44px");
    expect(styles).toContain("font-size:16px");
    expect(styles).toContain(".reporting-filters--orders .dx-field__control input");
    expect(styles).toContain(".dx-field__control input { min-height:0; }");
    expect(styles).toContain(".rework-query-more.is-open");
    expect(styles).not.toContain("minmax(0,1.35fr)");
  });

  it("uses available grid width instead of a 390px device-only form fix", async () => {
    const styles = await readFile("apps/web/src/styles.css", "utf8");

    expect(styles).toContain("repeat(auto-fit, minmax(min(220px, 100%), 1fr))");
    expect(styles).not.toContain(".rework-manual-entry__order-fields { grid-template-columns: repeat(2, minmax(0, 1fr)); }");
    expect(styles).not.toContain(".process-line__grid { grid-template-columns: 1fr; }");
  });

  it("keeps the safe frontline context layout through Pro Max widths", async () => {
    const styles = await readFile("apps/web/src/frontline-task-page.css", "utf8");

    expect(styles).toContain("@media(max-width:560px)");
    expect(styles).toContain(".frontline-work-context{grid-template-columns:auto minmax(0,1fr)}");
    expect(styles).toContain("repeat(auto-fit,minmax(min(140px,100%),1fr))");
  });
});
