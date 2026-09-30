import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow state visual contract", () => {
  it("keeps future quiet, completed visibly gray, and all active work blue", async () => {
    const css = await readFile("apps/web/src/workflow-state-visual.css", "utf8");
    const main = await readFile("apps/web/src/main.tsx", "utf8");

    expect(main).toContain('import "./workflow-state-visual.css";');
    expect(css).toContain(".rework-workflow__node.is-completed");
    expect(css).toContain("background: #dbe3ea;");
    expect(css).toContain(".rework-workflow__node.is-future");
    expect(css).toContain("background: #fbfcfd;");
    expect(css).toContain(".rework-workflow__node.is-current,");
    expect(css).toContain(".rework-workflow__node.is-followup");
    expect(css).toContain("background: var(--dx-v2-color-primary);");
  });

  it("keeps N02 readiness feedback with the save and submit actions", async () => {
    const [form, css] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.css", "utf8"),
    ]);

    expect(form).toContain('className="process-worker-actions"');
    expect(form).toContain('还需完成：{readinessIssues.join("；")}');
    expect(form.indexOf('className="process-worker-actions"')).toBeLessThan(
      form.indexOf('readinessIssues.length ? <p role="status">'),
    );
    expect(css).toContain(".process-worker-actions{display:grid");
    expect(css).toContain(".process-worker-actions p{margin:0");
    expect(css).toContain(".process-worker-actions p{grid-column:1/-1}");
  });
});
