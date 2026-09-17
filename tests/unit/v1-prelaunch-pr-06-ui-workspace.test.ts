import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch PR-06 UI and workspace clarity", () => {
  it("makes N05 compact, groups temporary workers by process and marks mismatches as danger", async () => {
    const [panel, styles] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/web/src/styles.css"),
    ]);

    expect(panel).toContain("temporaryWorkerGroups.map");
    expect(panel).toContain("quantity-process-card quantity-coefficient-card");
    expect(panel).toContain('tone={process.complete ? "success" : "danger"}');
    expect(panel).toContain('className="quantity-review-actions"');
    expect(styles).toContain(".quantity-process-card.is-mismatch { border-left: 4px solid var(--color-danger, #a12b2b); }");
    expect(styles).toContain(".whole-order-review-flow > .dx-surface { padding: 12px; }");
    expect(styles).toContain("min-height: 48px");
    expect(styles).toContain(".whole-order-review-flow .dx-field__control { min-height: 36px;");
  });

  it("defaults mobile photos and workflow to collapsed without changing desktop content", async () => {
    const [detail, compact] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/rework-detail-compact.css"),
    ]);

    expect(detail).toContain("const [mobileImagesExpanded, setMobileImagesExpanded] = useState(true)");
    expect(detail).toContain("const [mobileWorkflowExpanded, setMobileWorkflowExpanded] = useState(false)");
    expect(detail).toContain('aria-controls="order-images-content"');
    expect(detail).toContain('aria-controls="order-workflow-content"');
    expect(detail).toContain("activeWorkflowNode.number");
    expect(compact).toContain(".rework-detail-mobile-collapsible {\n  display: grid;");
    expect(compact).toContain(".rework-detail-mobile-collapsible {\n    display: none;");
    expect(compact).toContain(".rework-detail-mobile-collapsible.is-expanded");
    expect(compact).toContain(".rework-detail-target-layout .rework-detail-desktop-panel-heading");
    expect(compact).toContain("display: none !important;");
  });

  it("selects and scrolls to N03 while keeping a distinct historical IE pricing view", async () => {
    const [app, detail, configuration, assignment, navigation] = await Promise.all([
      read("apps/web/src/App.tsx"),
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/process-configuration-form.tsx"),
      read("apps/web/src/process-worker-assignment-form.tsx"),
      read("apps/web/src/internal-navigation.ts"),
    ]);

    expect(detail).toContain("?node=${key}#node-workspace");
    expect(detail).toContain('id="node-workspace"');
    expect(detail).toContain("workspaceNode={selected.key}");
    expect(navigation).toContain("scrollIntoView({ block: \"start\" })");
    expect(navigation).toContain("window.requestAnimationFrame");
    expect(app).toContain("installInternalNavigation(basePath, () => setLocation(readInternalLocation(basePath)))");
    expect(configuration).toContain('workspaceNode?: "process_configuration" | "ie_review"');
    expect(assignment).toContain('workspaceNode === "ie_review"');
    expect(assignment).toContain("IE 核价已完成");
    expect(assignment).toContain("IE 已核准并锁定的工序单价与执行人员快照");
  });

  it("centers the three workflow text lines with controlled spacing", async () => {
    const compact = await read("apps/web/src/rework-detail-compact.css");
    expect(compact).toContain("gap: 2px 6px;");
    expect(compact).toContain("padding: 7px 8px;");
    expect(compact).toContain("align-self: center;");
    expect(compact).toContain("scroll-margin-top: 12px;");
  });
});
