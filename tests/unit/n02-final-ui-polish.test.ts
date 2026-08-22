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

  it("locks ordinary process and tail inspection to the same desktop grid and control footprint", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-line{grid-template-columns:340px minmax(0,1fr);column-gap:16px;padding:10px 0 12px;border:0;border-radius:0;background:transparent}");
    expect(css).toContain(".process-worker-tail-body{grid-template-columns:340px minmax(0,1fr);gap:16px}");
    expect(css).toContain(".process-worker-fields,.process-worker-tail-work{width:340px;max-width:340px}");
    expect(css).toContain(".process-worker-line>.process-worker-picker>.process-worker-people-search,.process-worker-tail-body>.process-worker-picker>.process-worker-people-search{width:340px;min-width:340px;max-width:340px;height:38px;min-height:38px;border-radius:10px}");
    expect(css).toContain(".process-worker-heading-primary>b,.process-worker-picker__heading>b,.process-worker-tail-title-row>b{font-size:15px;line-height:1.25;font-weight:700}");
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
