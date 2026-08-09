import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N07 responsibility edit lifecycle", () => {
  it("cannot finalize a persisted draft while the operator is looking at unsaved edits", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("const hasUnsavedChanges = useMemo(");
    expect(panel).toContain("&& !hasUnsavedChanges");
    expect(panel).toContain('setMessage("当前页面有未保存修改，请先保存草稿，再正式判定。")');
    expect(panel).toContain('hasUnsavedChanges\n              ? "请先保存草稿"');
  });

  it("does not create no-op draft versions or discard edits during transfer", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("const saveNeeded = determination === null || hasUnsavedChanges");
    expect(panel).toContain("!saveNeeded || Boolean(busyAction)");
    expect(panel).toContain('determination && !hasUnsavedChanges ? "草稿已保存" : "保存草稿"');
    expect(panel).toContain('setMessage("当前页面有未保存修改，请先保存草稿，再转交处理人。")');
    expect(panel).toContain("hasUnsavedChanges || !transferUserId");
  });

  it("keeps independent confirmation as a prerequisite for a saved high-multiplier draft", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");
    const migration = await read("apps/api/migrations/0011_responsibility_authorization_handler_closure.sql");

    expect(panel).toContain("const highMultiplierPending = Boolean(");
    expect(panel).toContain("&& !highMultiplierPending");
    expect(panel).toContain('highMultiplierPending\n                ? "等待高倍率复核"');
    expect(migration).toContain("high multiplier submitter cannot confirm the same version");
  });
});
