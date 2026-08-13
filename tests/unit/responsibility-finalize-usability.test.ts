import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N07 responsibility edit lifecycle", () => {
  it("cannot finalize a persisted draft while the operator is looking at unsaved edits", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("const hasUnsavedChanges = useMemo(");
    expect(panel).toContain("&& !hasUnsavedChanges");
    expect(panel).toContain("disabled={!finalizable || Boolean(busyAction)}");
    expect(panel).toContain('hasUnsavedChanges ? "请先保存草稿"');
  });

  it("does not create no-op draft versions or discard edits during transfer", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("const saveNeeded = determination === null || hasUnsavedChanges");
    expect(panel).toContain("disabled={!allProcessesValid || !saveNeeded || Boolean(busyAction)}");
    expect(panel).toContain('saveNeeded ? "保存草稿" : "草稿已保存"');
    expect(panel).toContain("!transferReason.trim() || hasUnsavedChanges");
    expect(panel).toContain("hasUnsavedChanges || !transferUserId");
  });

  it("keeps the N07 external supplier and multiplier prerequisites before the owner-signature handoff", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");
    const migration = await read("apps/api/migrations/0054_n07_n11_responsibility_settlement.sql");

    expect(panel).toContain("multiplier >= 1200n && allocation.supplierId.length > 0");
    expect(panel).toContain("提交老板签字");
    expect(migration).toContain("'pending_responsibility_determination' AND NEW.status='pending_owner_signature'");
  });
});
