import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("N01 local-only draft contract", () => {
  it("never creates a rework order when the user presses save on the new-order page", async () => {
    const source = await readFile("apps/web/src/rework-v2-form.tsx", "utf8");
    const saveBlock = source.match(/const save = async \(\): Promise<void> => \{[\s\S]*?\n {2}const submit = async/);
    const saveSource = saveBlock?.[0] ?? "";
    const localBranchStart = saveSource.indexOf("if (!reworkOrderId && !order) {");
    const serverDraftStart = saveSource.indexOf("const saved = await persistServerDraft();");

    expect(saveSource).toBeTruthy();
    expect(localBranchStart).toBeGreaterThanOrEqual(0);
    expect(serverDraftStart).toBeGreaterThan(localBranchStart);
    const freshOrderSaveBranch = saveSource.slice(localBranchStart, serverDraftStart);
    expect(freshOrderSaveBranch).toContain("writeLocalN01Draft(form, images, receivingBatchId)");
    expect(freshOrderSaveBranch).toContain("已保存到本机；尚未创建返工单");
    expect(freshOrderSaveBranch).toContain("return;");
    expect(freshOrderSaveBranch).not.toContain("persistServerDraft");
    expect(freshOrderSaveBranch).not.toContain("rework-orders/drafts");
    expect(source).toContain('const LOCAL_N01_DRAFT_KEY = "dx-rework:n01-local-draft:v1";');
    expect(source).toContain("window.localStorage.setItem(LOCAL_N01_DRAFT_KEY");
    expect(source).toContain("parsed.receivingBatchId !== requestedBatchId");
  });

  it("restores saved fields and uploaded reports after returning to or refreshing N01", async () => {
    const source = await readFile("apps/web/src/rework-v2-form.tsx", "utf8");

    expect(source).toContain("const localDraftSeed = reworkOrderId || isFinishing ? null : readLocalN01Draft();");
    expect(source).toContain("localDraftSeed?.form ?? emptyForm()");
    expect(source).toContain("localDraftSeed?.images.map(restoredImage) ?? []");
    expect(source).toContain("tools/attachments/${image.attachmentId}/download?mode=preview");
    expect(source).toContain("已恢复本机保存资料；尚未创建返工单");
    expect(source).toContain("initialReceivingBatchId() ?? localDraftSeed?.receivingBatchId ?? undefined");
    expect(source).toContain('isFinishing ? "finishing/" : ""}receiving-entry/');
  });

  it("creates the server rework order only from the real submit path and clears the local copy after success", async () => {
    const source = await readFile("apps/web/src/rework-v2-form.tsx", "utf8");
    const serverDraftBlock = source.match(/const persistServerDraft = async[\s\S]*?\n {2}const save = async/);
    const submitBlock = source.match(/const submit = async \(\): Promise<void> => \{[\s\S]*?\n {2}const uploadFiles = async/);

    expect(serverDraftBlock?.[0]).toContain('"rework-orders/drafts"');
    expect(serverDraftBlock?.[0]).toContain("receivingBatchId,");
    expect(submitBlock?.[0]).toContain("() => persistServerDraft(false)");
    expect(submitBlock?.[0]).toContain("clearLocalN01Draft();");
    expect(submitBlock?.[0]).toContain("submit-v2");
  });
});
