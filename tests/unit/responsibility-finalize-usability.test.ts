import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N08 responsibility submission UX", () => {
  it("submits current edits in one action without forcing a visible draft-save step", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("const hasUnsavedChanges = useMemo(");
    expect(panel).toContain('const needsSave = determination === null || determination.stage === "finalized" || hasUnsavedChanges');
    expect(panel).toContain('"save-before-submit"');
    expect(panel).toContain('"finalize"');
    expect(panel).toContain("提交老板签字");
    expect(panel).not.toContain("请先保存草稿");
    expect(panel).not.toContain(">保存草稿<");
  });

  it("records the current DingTalk user instead of asking the operator to select a responsibility handler", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain('requestCurrentUserId');
    expect(panel).toContain('const handlerUserId = response?.handlerUserId ?? currentUserId');
    expect(panel).not.toContain("新的责任处理人");
    expect(panel).not.toContain("责任处理人</span>");
    expect(panel).not.toContain("转交责任处理");
  });

  it("lets an owner take over without entering a reason while preserving the existing audited takeover command", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");

    expect(panel).toContain("确认接管当前责任处理？");
    expect(panel).toContain('reason: "老板主动接管"');
    expect(panel).not.toContain("接管原因");
    expect(panel).not.toContain("takeoverReason");
  });

  it("keeps external supplier and multiplier prerequisites before the owner-signature handoff", async () => {
    const panel = await read("apps/web/src/responsibility-determination-panel.tsx");
    const migration = await read("apps/api/migrations/0054_n07_n11_responsibility_settlement.sql");

    expect(panel).toContain("multiplier >= 1200n && allocation.supplierId.length > 0");
    expect(panel).toContain("责任供应商");
    expect(panel).toContain("外部扣款倍率（最低 1.2）");
    expect(migration).toContain("'pending_responsibility_determination' AND NEW.status='pending_owner_signature'");
  });
});
