import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 desktop shared-row grid", () => {
  it("places process and personnel content on the same explicit desktop rows", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain("@media(min-width:981px)");
    expect(css).toContain("grid-template-columns:340px minmax(0,1fr);grid-template-rows:28px 30px 58px minmax(58px,auto)");
    expect(css).toContain(".process-worker-line__body,.process-worker-fields,.process-worker-line .process-worker-picker{display:contents}");
    expect(css).toContain(".process-worker-fields>.dx-field:nth-child(2){grid-column:1;grid-row:3");
    expect(css).toContain(".process-worker-line .process-worker-picker>.process-worker-people-search{grid-column:2;grid-row:3;align-self:end;width:340px");
    expect(css).toContain(".process-worker-fields>.dx-field:nth-child(3){grid-column:1;grid-row:4");
    expect(css).toContain(".process-worker-line .process-worker-picker>.process-worker-people-groups{grid-column:2;grid-row:4");
  });

  it("uses the identical row skeleton for tail inspection", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-tail-body{display:grid;grid-template-columns:340px minmax(0,1fr);grid-template-rows:28px 30px 58px auto");
    expect(css).toContain(".process-worker-tail-work,.process-worker-tail-body>.process-worker-picker{display:contents}");
    expect(css).toContain(".process-worker-tail-work>.dx-field{grid-column:1;grid-row:3");
    expect(css).toContain(".process-worker-tail-body>.process-worker-picker>.process-worker-people-search{grid-column:2;grid-row:3;align-self:end;width:340px");
  });

  it("locks the four peer titles to one typography rule without changing mobile breakpoints", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain("font-size:15px!important;font-weight:700!important;line-height:1.25!important");
    expect(css).toContain("@media(max-width:640px)");
    expect(css).toContain(".process-worker-mobile-assign{background:var(--dx-v2-color-primary)!important");
  });
});
