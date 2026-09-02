import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business action readiness contract", () => {
  it("keeps N01, historical tail counts and N08 clickable with explicit validation feedback", async () => {
    const [initiation, tailInspection, responsibility] = await Promise.all([
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/web/src/tail-inspection-panel.tsx", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
    ]);

    expect(initiation).toContain("const submissionIssue =");
    expect(initiation).toContain("const complete = submissionIssue === null;");
    expect(initiation).toContain("await alertInApp(submissionIssue");
    expect(initiation).toContain('disabled={busy || uploading || (Boolean(reworkOrderId) && !order)}');
    expect(initiation).not.toContain("busy || uploading || !complete");

    expect(tailInspection).toContain('title: "整查数量暂不能提交"');
    expect(tailInspection).toContain('data-ready={tailSubmitReady ? "true" : "false"}');
    expect(tailInspection).toContain("const quantityText = processQuantities[process.configurationItemId]?.trim() ??");
    expect(tailInspection).toContain("!isPieceCount(item.quantityText)");
    expect(tailInspection).toContain('disabled={busy} onClick={() => void submit()}');

    expect(responsibility).toContain("const processValidationIssue =");
    expect(responsibility).toContain("const submissionIssue =");
    expect(responsibility).toContain('title: "责任判定暂不能提交"');
    expect(responsibility).toContain('disabled={Boolean(busyAction)}');
    expect(responsibility).not.toContain('disabled={!allProcessesValid || !handlerUserId || Boolean(busyAction)}');
    expect(responsibility).toContain('const needsSave = determination === null || determination.stage === "finalized" || hasUnsavedChanges');
  });

  it("gates N02 save, submit and IE rejection with deterministic prerequisites", async () => {
    const source = await readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8");
    expect(source).toContain("const itemIssue = validateItems(items);");
    expect(source).toContain("const workerIssue = items.findIndex");
    expect(source).toContain("const submitReady = saveReady;");
    expect(source).toContain('disabled={busy || !saveReady}');
    expect(source).toContain('disabled={busy || !submitReady}');
    expect(source).toContain('还需完成：{readinessIssues.join("；")}');
    expect(source.indexOf('className="process-worker-actions"')).toBeLessThan(
      source.indexOf('readinessIssues.length ? <p role="status">'),
    );
    expect(source).toContain('disabled={busy || !reviewReason.trim()}');
  });

  it("keeps historical assignment gated and N04 reporting ready before the user can trigger a no-op", async () => {
    const source = await readFile("apps/web/src/work-reporting-form.tsx", "utf8");
    expect(source).toContain("const selectedPeopleCount =");
    expect(source).toContain('disabled={busy || selectedPeopleCount === 0}');
    expect(source).toContain("const reportsReady = Boolean(");
    expect(source).toContain('disabled={busy || !reportsReady}');
  });

  it("gates the N05 final action below deterministic readiness text", async () => {
    const wholeOrder = await readFile("apps/web/src/whole-order-review-panel.tsx", "utf8");
    expect(wholeOrder).toContain("const coefficientIssue =");
    expect(wholeOrder).toContain("const ready = allComplete && !priceIssue && !coefficientIssue;");
    expect(wholeOrder).not.toContain("finalQuantities");
    expect(wholeOrder).toContain('disabled={busy || !ready}');
    expect(wholeOrder.indexOf('disabled={busy || !ready}')).toBeLessThan(
      wholeOrder.indexOf('{!ready && <p role="status">'),
    );
  });

  it("requires a rejection reason before the N09 own-factory rejection action is enabled", async () => {
    const source = await readFile("apps/web/src/own-factory-approval-panel.tsx", "utf8");
    expect(source).toContain('disabled={Boolean(busy) || !opinion.trim()}');
  });

  it("gates external supplier allocation and the simplified deduction action", async () => {
    const source = await readFile("apps/web/src/external-responsibility-panel.tsx", "utf8");
    expect(source).toContain("const supplierAllocationReady =");
    expect(source).toContain('disabled={busy || !supplierAllocationReady}');
    expect(source).toContain('disabled={busy || !temporaryNameReady}');
    expect(source).toContain("const deductionReady = inputCents !== null");
    expect(source).toContain("&& inputCents <= remainingCents;");
    expect(source).toContain('disabled={busy || !deductionReady}');
    expect(source).toContain("本次扣款金额不能超过当前剩余应扣金额");
    expect(source.indexOf('className="external-case-actions"')).toBeLessThan(
      source.indexOf('<small role="status">请输入大于 0、最多两位小数且不超过剩余金额的本次扣款。</small>'),
    );
    expect(source).toContain("requestRevision(caseItem)");
  });

  it("gates deterministic system-management create and import actions", async () => {
    const [workforce, masterData] = await Promise.all([
      readFile("apps/web/src/workforce-master-data-page.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.tsx", "utf8"),
    ]);
    expect(workforce).toContain('disabled={busy || !name.trim()}');
    expect(masterData).toContain('disabled={Boolean(busy) || !supplierName.trim()}');
    expect(masterData).toContain('disabled={Boolean(busy) || !processName.trim()}');
    expect(masterData).toContain('previewSummary.error > 0 || !importReason.trim() || previewSummary.create + previewSummary.update === 0');
  });
});
