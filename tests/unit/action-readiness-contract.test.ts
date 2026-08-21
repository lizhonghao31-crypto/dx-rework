import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("business action readiness contract", () => {
  it("keeps N01 readiness and gates the simplified N08 submit action", async () => {
    const [initiation, responsibility] = await Promise.all([
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
    ]);

    expect(initiation).toContain("const complete = Boolean(");
    expect(initiation).toContain("availableImageCount > 0");
    expect(initiation).toContain('disabled={busy || uploading || !complete || (Boolean(reworkOrderId) && !order)}');
    expect(responsibility).toContain("const allProcessesValid = processes.length > 0 && processes.every(processValid);");
    expect(responsibility).toContain("!response || !editable || !allProcessesValid || !handlerUserId || busyAction");
    expect(responsibility).toContain('disabled={!allProcessesValid || !handlerUserId || Boolean(busyAction)}');
    expect(responsibility).toContain('const needsSave = determination === null || determination.stage === "finalized" || hasUnsavedChanges');
  });

  it("gates N02 save, submit and IE rejection with deterministic prerequisites", async () => {
    const source = await readFile("apps/web/src/process-configuration-form.tsx", "utf8");
    expect(source).toContain("const itemValidationError = validateItemForms(items);");
    expect(source).toContain("const submitReady = editable && submitReadinessIssues.length === 0;");
    expect(source).toContain('disabled={busy || !saveReady}');
    expect(source).toContain('disabled={busy || !submitReady}');
    expect(source).toContain('还需完成：{submitReadinessIssues.join("；")}');
    expect(source.indexOf('className="mobile-actions process-configuration-actions"')).toBeLessThan(
      source.indexOf('className="process-readiness" role="status"'),
    );
    expect(source).toContain('disabled={busy || !reviewReason.trim()}');
  });

  it("gates N04 assignment and N05 reporting before the user can trigger a no-op", async () => {
    const source = await readFile("apps/web/src/work-reporting-form.tsx", "utf8");
    expect(source).toContain("const selectedPeopleCount =");
    expect(source).toContain('disabled={busy || selectedPeopleCount === 0}');
    expect(source).toContain("const reportsReady = Boolean(");
    expect(source).toContain('disabled={busy || !reportsReady}');
  });

  it("gates N06 and N07 final actions and keeps readiness text below those actions", async () => {
    const [tail, wholeOrder] = await Promise.all([
      readFile("apps/web/src/tail-inspection-panel.tsx", "utf8"),
      readFile("apps/web/src/whole-order-review-panel.tsx", "utf8"),
    ]);
    expect(tail).toContain("const tailSubmitReady = Boolean(");
    expect(tail).toContain('disabled={busy || !tailSubmitReady}');
    expect(tail.indexOf('className="mobile-actions tail-inspection-actions"')).toBeLessThan(
      tail.indexOf('className="tail-inspection-readiness" role="status"'),
    );
    expect(wholeOrder).toContain("const temporaryCoefficientIssue =");
    expect(wholeOrder).toContain("const wholeOrderReady = allComplete && temporaryCoefficientIssue === \"\";");
    expect(wholeOrder).toContain('disabled={busy || !wholeOrderReady}');
    expect(wholeOrder.lastIndexOf('className="mobile-actions"')).toBeLessThan(
      wholeOrder.lastIndexOf('{temporaryCoefficientIssue && <p role="status">'),
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
