import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 mobile personnel assignment", () => {
  it("keeps the assignment button directly beside each process title and shows only the assignment result on the card", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    expect(source).toContain('<div className="process-worker-heading-primary"><b>工序');
    expect(source).toContain('className="process-worker-mobile-assign"');
    expect(source).toContain('className="process-worker-mobile-assigned-summary"');
    expect(source).toContain('assignedNames.join("、")');
    expect(source).toContain('<div className="process-worker-tail-title-row"><b>尾查</b><Button className="process-worker-mobile-assign"');
  });

  it("uses a temporary selection draft so cancel does not mutate the form and confirm writes the shared worker state", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    expect(source).toContain("type MobileAssignmentDraft");
    expect(source).toContain("const cancelMobileAssignment = () =>");
    expect(source).toContain("const confirmMobileAssignment = () =>");
    expect(source).toContain("setWorkerIds((current) => ({ ...current, [key]: selectedIds }))");
    expect(source).toContain("setTailPersonIds(selectedIds)");
    expect(source).toContain("确认分配");
    expect(source).toContain("取消");
  });

  it("collapses the full picker on phones and opens a bottom sheet while keeping price below the process selector", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-mobile-sheet.css", "utf8");
    expect(css).toContain(".process-worker-line>.process-worker-line__body>.process-worker-picker,.process-worker-tail-body>.process-worker-picker{display:none}");
    expect(css).toContain(".process-worker-fields{grid-template-columns:1fr");
    expect(css).toContain(".process-worker-heading-primary{gap:6px");
    expect(css).toContain(".process-worker-mobile-sheet-backdrop{position:fixed;inset:0");
    expect(css).toContain("align-items:end");
    expect(css).toContain("max-height:min(82vh,720px)");
  });
});
