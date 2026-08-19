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

  it("keeps N02 readiness feedback under the right-hand submit action", async () => {
    const css = await readFile("apps/web/src/workflow-state-visual.css", "utf8");
    const form = await readFile("apps/web/src/process-configuration-form.tsx", "utf8");

    expect(form).toContain('className="process-readiness"');
    expect(form).toContain("还需完成：{submitReadinessIssues.join");
    expect(css).toContain(".process-configuration-page .process-readiness");
    expect(css).toContain("width: calc(50% - 6px);");
    expect(css).toContain("margin: 2px 0 0 auto;");
  });
});
