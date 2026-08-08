import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("workflow shell layout", () => {
  it("centers constrained business workspaces on desktop while keeping mobile full width", async () => {
    const css = await read("apps/web/src/workflow-shell.css");
    expect(css).toContain(".app-shell > main .mobile-page {");
    expect(css).toContain("margin: 0 auto;");
    expect(css).toContain(".app-shell > main .process-configuration-page");
    expect(css).toContain(".app-shell > main .work-reporting-page");
    expect(css).toContain("@media (max-width: 800px)");
    expect(css).toContain("width: 100%;");
  });
});
