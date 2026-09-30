import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch PR-09 mobile workspace density", () => {
  it("keeps the processing-factory prefill but removes its height-raising helper copy", async () => {
    const [panel, styles] = await Promise.all([
      read("apps/web/src/responsibility-determination-panel.tsx"),
      read("apps/web/src/responsibility-determination.css"),
    ]);

    expect(panel).toContain("preferredProcessingFactoryId");
    expect(panel).not.toContain("已带入订单加工厂，可重新选择");
    expect(panel).not.toContain("supplierOptionsLoaded");
    expect(styles).not.toContain(".responsibility-supplier-field small");
  });

  it("places order status beside the RW number and removes duplicate mobile panel headings", async () => {
    const [components, detail, compact, styles] = await Promise.all([
      read("apps/web/src/components.tsx"),
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/rework-detail-compact.css"),
      read("apps/web/src/styles.css"),
    ]);

    expect(components).toContain('badgePlacement?: "actions" | "subtitle"');
    expect(detail).toContain('badgePlacement="subtitle"');
    expect(styles).toContain(".page-heading__subtitle-row");
    expect(compact).toContain(".rework-detail-target-layout .rework-detail-desktop-panel-heading");
    expect(compact).toContain("display: none !important;");
    expect(detail).toContain('id="order-images-content" className="rework-detail-mobile-collapsible is-expanded"');
    expect(detail).toContain("const [mobileWorkflowExpanded, setMobileWorkflowExpanded] = useState(false)");
  });

  it("renames and collapses the complete temporary-worker wage adjustment section", async () => {
    const [panel, styles] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/web/src/styles.css"),
    ]);

    expect(panel).toContain("const [coefficientSectionExpanded, setCoefficientSectionExpanded] = useState(false)");
    expect(panel).toContain("<strong>临时工工资调整</strong>");
    expect(panel).toContain("{coefficientSectionExpanded && <div className=\"quantity-process-list\" id=\"temporary-wage-adjustment-content\">");
    expect(panel).not.toContain("<h2>临时工系数</h2>");
    expect(styles).toContain(".quantity-coefficient-section-toggle");
  });
});
