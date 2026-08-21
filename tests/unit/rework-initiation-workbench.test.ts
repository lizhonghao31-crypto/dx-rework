import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework initiation information architecture", () => {
  it("keeps the standalone initiation page dedicated to one new order and routes follow-up work to order detail", async () => {
    const [app, form, detail, shell] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/workflow-shell.css", "utf8"),
    ]);

    expect(app).toContain("<ReworkInitiationV2Form />");
    expect(app).not.toContain("ReworkInitiationWorkbench");
    expect(form).not.toContain('get("draft")');
    expect(form).toContain('get("styleNo")');
    expect(form).toContain("window.location.assign(pageUrl(`ui/tasks/${submitted.reworkOrderId}`))");
    expect(form).toContain("只填返工真正需要的资料");
    expect(detail).toContain("InitiationFollowUpActions");
    expect(detail).toContain("<ReworkInitiationForm");
    expect(detail).toContain('reworkOrderId={detail.reworkOrderId}');
    expect(detail).toContain('detail.status === "pending_process_configuration"');
    expect(detail).toContain('const defaultSelectedNode = activeNode ?? "settlement_followup";');
    expect(detail).toContain("const selectedNode = selectedFromUrl");
    expect(detail).not.toContain('detail.status === "pending_process_configuration" ? "initiation"');
    expect(shell).toContain(".app-shell > aside .primary-navigation");
  });

  it("uses one title structure and removes the payroll eyebrow", async () => {
    const [components, styles, wage, admin] = await Promise.all([
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/styles.css", "utf8"),
      readFile("apps/web/src/wages/wage-period-list.tsx", "utf8"),
      readFile("apps/web/src/admin-console-page.tsx", "utf8"),
    ]);

    expect(components).toContain('<header className="page-heading">');
    expect(components).toContain('className="page-heading__subtitle"');
    expect(styles).toContain(".page-heading__subtitle");
    expect(styles).toContain("var(--dx-v2-color-primary)");
    expect(wage).not.toContain('className="eyebrow"');
    expect(admin).toContain('<header className="page-heading">');
  });
});
