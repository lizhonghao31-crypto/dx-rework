import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 mobile personnel assignment", () => {
  it("puts the default-worker actions beside the personnel title and shows compact removable names", async () => {
    const [source, styles] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.css", "utf8"),
    ]);
    expect(source).toContain('<div className="process-worker-picker__heading"><b>返工人员 *</b>');
    expect(source).toContain('className="process-worker-add-default" variant="primary"');
    expect(source).toContain('item.source === "catalog" ? "＋ 增加默认工人" : "＋ 增加工人"');
    expect(source).toContain('className="process-worker-save-default"');
    expect(source).toContain('className="process-worker-default-list"');
    expect(source).toContain('onClick={() => removeWorker(index, personId)}>−</button><small>{person?.displayName ?? "返工人员"}');
    expect(styles).toContain(".process-worker-picker__heading{justify-content:flex-start}");
    expect(source).toContain('<div className="process-worker-tail-title-row"><b>尾查</b><Button className="process-worker-mobile-assign"');
  });

  it("uses a temporary selection draft so cancel does not mutate the form and confirm writes the shared worker state", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    expect(source).toContain("type MobileAssignmentDraft");
    expect(source).toContain("const cancelMobileAssignment = () =>");
    expect(source).toContain("const confirmMobileAssignment = () =>");
    expect(source).toContain("setWorkerIds((current) => ({ ...current, [key]: selectedIds }))");
    expect(source).toContain("setTailPersonIds(selectedIds)");
    expect(source).toContain("markDefaultRosterDirty(mobileAssignment.index)");
    expect(source).toContain("确认添加");
    expect(source).toContain("确认分配");
    expect(source).toContain("取消");
  });

  it("keeps compact worker actions visible on phones and opens a bottom sheet for selection", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-tail-body>.process-worker-picker{display:none}");
    expect(css).not.toContain(".process-worker-line>.process-worker-line__body>.process-worker-picker,.process-worker-tail-body>.process-worker-picker{display:none}");
    expect(css).toContain(".process-worker-fields{grid-template-columns:1fr");
    expect(css).toContain('.process-worker-line{grid-template-areas:"heading picker" "fields picker";grid-template-columns:minmax(120px,.82fr) minmax(0,1.18fr)');
    expect(css).toContain(".process-worker-fields{grid-area:fields;grid-column:1;grid-row:2");
    expect(css).toContain(".process-worker-line .process-worker-picker{grid-area:picker;grid-column:2;grid-row:1/3");
    expect(css).toContain(".process-worker-line__heading>b,.process-worker-picker__heading>b{line-height:32px!important");
    expect(css).toContain(".process-worker-picker__heading{display:flex;min-height:32px");
    expect(css).toContain(".process-worker-roster-actions .dx-button{position:relative;min-height:32px!important");
    expect(css).toContain('.process-worker-roster-actions .dx-button::after{content:"";position:absolute;inset:-6px 0}');
    expect(css).toContain(".process-worker-source{display:grid;grid-template-columns:minmax(0,1fr)");
    expect(css).toContain(".process-worker-source label{width:max-content;max-width:100%;white-space:nowrap}");
    expect(css).toContain(".process-worker-actions{position:static;bottom:auto;z-index:auto");
    expect(css).toContain(".process-worker-heading-primary{gap:6px");
    expect(css).toContain(".process-worker-mobile-sheet-backdrop{position:fixed;inset:0");
    expect(css).toContain("align-items:end");
    expect(css).toContain("max-height:min(82vh,720px)");
  });
});
