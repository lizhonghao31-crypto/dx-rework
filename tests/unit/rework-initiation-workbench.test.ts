import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("rework initiation workbench", () => {
  it("keeps multiple N01 orders recoverable after navigation", async () => {
    const [app, workbench] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/rework-initiation-workbench.tsx", "utf8"),
    ]);

    expect(app).toContain("<ReworkInitiationWorkbench />");
    expect(workbench).toContain('apiUrl("rework-orders")');
    expect(workbench).toContain("我的返工单");
    expect(workbench).toContain("新建返工");
    expect(workbench).toContain("pending_process_configuration");
    expect(workbench).toContain("setDraftQuery(orderId)");
  });

  it("reserves sidebar space for the account block", async () => {
    const css = await readFile("apps/web/src/rework-workbench.css", "utf8");
    expect(css).toContain("max-height: calc(100vh - 240px)");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain(".app-shell > aside .org");
  });
});
