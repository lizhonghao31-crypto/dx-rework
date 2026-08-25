import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 final UI polish", () => {
  it("uses one desktop field width/height system and gives process cards the tail surface color", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-line{background:var(--dx-v2-color-surface)}");
    expect(css).toContain(".process-worker-fields{grid-template-columns:minmax(0,1fr);max-width:340px}");
    expect(css).toContain(".process-worker-fields>.dx-field,.process-worker-tail-work>.dx-field{width:100%;max-width:340px;min-width:0}");
    expect(css).toContain("min-height:38px;border:1px solid #b9c8d6;border-radius:10px;box-shadow:none");
  });

  it("locks ordinary process and tail inspection to the same shared desktop row system", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-line{display:grid;grid-template-areas:none;grid-template-columns:340px minmax(0,1fr);grid-template-rows:28px 30px 58px minmax(58px,auto)");
    expect(css).toContain(".process-worker-tail-body{display:grid;grid-template-columns:340px minmax(0,1fr);grid-template-rows:28px 30px 58px auto");
    expect(css).toContain(".process-worker-line__body,.process-worker-fields,.process-worker-line .process-worker-picker{display:contents}");
    expect(css).toContain(".process-worker-line .process-worker-picker>.process-worker-people-search{grid-column:2;grid-row:3;align-self:end;width:340px");
    expect(css).toContain(".process-worker-tail-body>.process-worker-picker>.process-worker-people-search{grid-column:2;grid-row:3;align-self:end;width:340px");
    expect(css).toContain("font-size:15px!important;font-weight:700!important;line-height:1.25!important");
  });

  it("makes the mobile assignment button primary and keeps mobile borders crisp", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-mobile-assign{background:var(--dx-v2-color-primary)!important");
    expect(css).toContain("color:#fff!important");
    expect(css).toContain(".process-worker-mobile-sheet{border:1px solid #aebdcc;box-shadow:none}");
    expect(css).toContain(".process-worker-mobile-sheet>.process-worker-people-search{font-size:16px}");
  });

  it("does not autofocus the mobile personnel search when the sheet opens", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    const marker = 'value={mobileAssignmentSearch}';
    const start = source.indexOf(marker);
    expect(start).toBeGreaterThanOrEqual(0);
    const sheetSearch = source.slice(start, start + 520);
    expect(sheetSearch).toContain("onChange");
    expect(sheetSearch).not.toContain("autoFocus");
  });
});
