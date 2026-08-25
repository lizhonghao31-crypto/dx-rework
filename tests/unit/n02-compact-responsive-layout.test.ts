import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 compact responsive layout", () => {
  it("aligns the process title with the personnel title on desktop without changing the form DOM", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-form.css", "utf8");

    expect(css).toContain('grid-template-areas:"heading picker" "fields picker"');
    expect(css).toContain(".process-worker-line__body{display:contents}");
    expect(css).toContain(".process-worker-fields{grid-area:fields;grid-template-columns:minmax(0,1.45fr) minmax(118px,.75fr)");
    expect(css).toContain(".process-worker-picker{grid-area:picker;gap:6px;padding-left:16px}");
    expect(css).toContain(".process-worker-selected{display:flex;align-items:center;gap:8px;min-height:28px}");
  });

  it("packs personnel horizontally while keeping large directories bounded", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-form.css", "utf8");

    expect(css).toContain(".process-worker-people-group>div{grid-template-columns:repeat(2,minmax(0,1fr));column-gap:4px;row-gap:1px;max-height:112px;overflow:auto}");
    expect(css).toContain(".process-worker-people-group--tail>div{grid-template-columns:repeat(3,minmax(0,1fr));max-height:112px}");
    expect(css).toContain("text-overflow:ellipsis;white-space:nowrap");
  });

  it("keeps personnel search inside the picker and gives mobile results two columns", async () => {
    const [css, form] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.css", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
    ]);

    expect(css).toContain(".process-worker-people-search{display:block;visibility:visible;opacity:1;min-height:36px");
    expect(css).toContain("border-color:#b9c8d6;background:var(--dx-v2-color-inset)");
    expect(css).toContain("@media(max-width:640px)");
    expect(css).toContain(".process-worker-people-group>div,.process-worker-people-group--tail>div{grid-template-columns:repeat(2,minmax(0,1fr));max-height:118px}");
    expect(css).toContain("@media(max-width:380px)");
    expect(form).toContain("mobileAssignmentSearch");
    expect(form).toContain('placeholder="搜索正式工或临时工"');
    expect(form).not.toContain('placeholder="搜索尾查人员"');
    expect(form).not.toContain("workerSearches");
  });
});
