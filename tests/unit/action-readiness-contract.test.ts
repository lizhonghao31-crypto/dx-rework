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

  it("keeps N02 save, submit and IE rejection clickable with explicit feedback", async () => {
    const [source, legacy] = await Promise.all([
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/legacy-process-configuration-form.tsx", "utf8"),
    ]);
    for (const page of [source, legacy]) {
      expect(page).toContain("alertInApp");
      expect(page).toContain("data-ready=");
    }
    expect(source).toContain("const configurationIssue =");
    expect(source).toContain('title: "工序与人员暂不能提交"');
    expect(source).toContain('disabled={Boolean(history) || busy || assignmentOptionsLoading}');
    expect(source).not.toContain('disabled={busy || !submitReady}');
    expect(source).toContain('title: "核价暂不能驳回"');
    expect(legacy).toContain('title: "工序配置暂不能提交"');
    expect(legacy).toContain('disabled={busy}>{busy ? "提交中…"');
    expect(legacy).not.toContain('disabled={busy || !submitReady}');
    expect(legacy).toContain('title: "审核暂不能驳回"');
  });

  it("keeps historical assignment and N04 reporting clickable with explicit feedback", async () => {
    const source = await readFile("apps/web/src/work-reporting-form.tsx", "utf8");
    expect(source).toContain('title: "人员分配暂不能提交"');
    expect(source).toContain('title: "返工暂不能开始"');
    expect(source).toContain('title: "新增员工暂不能提交"');
    expect(source).toContain('title: "临时工暂不能添加"');
    expect(source).toContain('title: "返工报数暂不能提交"');
    expect(source).toContain('data-ready={reportsReady ? "true" : "false"}');
    expect(source).toContain('onClick={() => void submitReports()} disabled={busy}');
    expect(source).not.toContain('disabled={busy || !reportsReady}');
  });

  it("keeps N05 and IE price review clickable with explicit feedback", async () => {
    const wholeOrder = await readFile("apps/web/src/whole-order-review-panel.tsx", "utf8");
    expect(wholeOrder).toContain("const coefficientIssue =");
    expect(wholeOrder).toContain("const ready = allComplete && !priceIssue && !coefficientIssue;");
    expect(wholeOrder).toContain('title: "数量暂不能提交 IE"');
    expect(wholeOrder).toContain('title: "IE 复核暂不能提交"');
    expect(wholeOrder).toContain('data-ready={ready ? "true" : "false"}');
    expect(wholeOrder).toContain('onClick={() => void confirmQuantities()} disabled={busy || Boolean(history)}');
    expect(wholeOrder).not.toContain('disabled={busy || !ready}');
    expect(wholeOrder).toContain('data-ready={priceReviewReady ? "true" : "false"}');
    expect(wholeOrder).not.toContain('disabled={busy || !priceReviewReady}');
  });

  it("keeps the N09 own-factory rejection clickable with explicit feedback", async () => {
    const source = await readFile("apps/web/src/own-factory-approval-panel.tsx", "utf8");
    expect(source).toContain('title: "本厂承担暂不能驳回"');
    expect(source).toContain('data-ready={opinion.trim() ? "true" : "false"}');
    expect(source).not.toContain('disabled={Boolean(busy) || !opinion.trim()}');
  });

  it("keeps external allocation and deduction clickable with explicit feedback", async () => {
    const source = await readFile("apps/web/src/external-responsibility-panel.tsx", "utf8");
    expect(source).toContain('title: "供应商暂不能新增"');
    expect(source).toContain('title: "供应商分配暂不能提交"');
    expect(source).toContain('title: "扣款暂不能提交"');
    expect(source).toContain('data-ready={supplierAllocationReady ? "true" : "false"}');
    expect(source).toContain('data-ready={temporaryNameReady ? "true" : "false"}');
    expect(source).toContain('data-ready={deductionReady ? "true" : "false"}');
    expect(source).not.toContain('disabled={busy || !supplierAllocationReady}');
    expect(source).not.toContain('disabled={busy || !temporaryNameReady}');
    expect(source).toContain('disabled={busy || !deductionReady}');
    expect(source).toContain("confirmDeductionException");
    expect(source).toContain("requestRevision(caseItem)");
  });

  it("keeps system-management create and import actions clickable with explicit feedback", async () => {
    const [workforce, masterData] = await Promise.all([
      readFile("apps/web/src/workforce-master-data-page.tsx", "utf8"),
      readFile("apps/web/src/master-data-page.tsx", "utf8"),
    ]);
    expect(workforce).toContain('title: "临时工档案暂不能建立"');
    expect(workforce).toContain('data-ready={name.trim() ? "true" : "false"}');
    expect(workforce).not.toContain('disabled={busy || !name.trim()}');

    expect(masterData).toContain('title: "工艺暂不能新增"');
    expect(masterData).toContain('title: "供应商暂不能新增"');
    expect(masterData).toContain('title: "工序暂不能新增"');
    expect(masterData).toContain('title: "批量资料暂不能导入"');
    expect(masterData).toContain('data-ready={craftName.trim() ? "true" : "false"}');
    expect(masterData).toContain('data-ready={supplierName.trim() ? "true" : "false"}');
    expect(masterData).toContain('data-ready={processName.trim() ? "true" : "false"}');
    expect(masterData).not.toContain('disabled={Boolean(busy) || !supplierName.trim()}');
    expect(masterData).not.toContain('disabled={Boolean(busy) || !processName.trim()}');
    expect(masterData).toContain("previewSummary.error === 0");
  });

});
