import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 mobile personnel assignment", () => {
  it("puts the default-worker actions beside the personnel title and shows compact removable names", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    expect(source).toContain('<div className="process-worker-picker__heading"><b>返工人员 *</b>');
    expect(source).toContain('className="process-worker-add-default" variant="primary"');
    expect(source).toContain('className="process-worker-save-default"');
    expect(source).toContain('className="process-worker-default-list"');
    expect(source).toContain('onClick={() => removeWorker(index, personId)}>−</button>');
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
    expect(css).toContain(".process-worker-heading-primary{gap:6px");
    expect(css).toContain(".process-worker-mobile-sheet-backdrop{position:fixed;inset:0");
    expect(css).toContain("align-items:end");
    expect(css).toContain("max-height:min(82vh,720px)");
  });
});
