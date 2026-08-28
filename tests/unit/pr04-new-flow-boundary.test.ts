import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("PR-04 new-flow boundary", () => {
  it("does not expose the retired standalone tail-inspection node in the current order flow", async () => {
    const detail = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(detail).not.toContain('node("tail_inspection"');
    expect(detail).not.toContain("<TailInspectionPanel");
    expect(detail).not.toContain('if (value === "tail_inspection")');
  });

  it("does not let N02 create the retired standalone tail-inspection assignment/todo path", async () => {
    const [form, service] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/api/src/rework/process-configuration-service.ts", "utf8"),
    ]);
    expect(form).not.toContain("分配整查");
    expect(form).not.toContain("tail-inspection-options");
    expect(form).not.toContain("历史整查分配");
    expect(service).not.toContain("INSERT INTO rework_tail_inspection_assignments");
    expect(service).not.toContain('category: "tail_inspection"');
    expect(service).not.toContain('tab: "tail_inspection"');
  });
});
