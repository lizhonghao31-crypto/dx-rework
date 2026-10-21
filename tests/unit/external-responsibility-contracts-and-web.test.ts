import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import {
  AllocateExternalSuppliersSchema,
  CloseExternalDeductionCaseSchema,
  CreateExternalDeductionEntrySchema,
  CreateExternalResponsibilityRevisionSchema,
  PayablesReturnExternalResponsibilityCaseSchema,
} from "@dx-rework/contracts/external-responsibility";
import { describe, expect, it } from "vitest";

const id = () => randomUUID();

describe("PR-11 external responsibility contracts and mobile UI", () => {
  it("rejects client money, duplicate coverage, invalid evidence, and unstructured revisions", () => {
    const externalItemId = id();
    const configurationItemId = id();
    expect(AllocateExternalSuppliersSchema.safeParse({
      expectedBatchVersion: 1,
      allocations: [
        { responsibilityType: "processing_factory", supplierId: id(), externalItemIds: [externalItemId] },
        { responsibilityType: "processing_factory", supplierId: id(), externalItemIds: [externalItemId] },
      ],
    }).success).toBe(false);
    expect(CloseExternalDeductionCaseSchema.safeParse({
      expectedCaseVersion: 1,
      result: "partial",
      reason: "供应商拒扣",
      evidenceAttachmentIds: [],
    }).success).toBe(false);
    expect(CloseExternalDeductionCaseSchema.safeParse({
      expectedCaseVersion: 1,
      result: "partial",
      reason: "供应商拒扣",
      evidenceAttachmentIds: [id()],
    }).success).toBe(false);
    expect(CloseExternalDeductionCaseSchema.safeParse({
      expectedCaseVersion: 1,
      result: "partial",
      reason: "供应商拒扣",
      evidenceAttachmentIds: [id()],
      remainingDifferenceDisposition: "申请责任重判并转本厂承担",
    }).success).toBe(true);
    expect(PayablesReturnExternalResponsibilityCaseSchema.safeParse({
      expectedCaseVersion: 1,
      attachmentIds: [],
    }).success).toBe(false);
    expect(CreateExternalDeductionEntrySchema.safeParse({
      expectedCaseVersion: 1,
      entryType: "deduction",
      amount: "-1.00",
      deductedOn: "2026-08-03",
      attachmentIds: [],
    }).success).toBe(false);
    expect(CreateExternalResponsibilityRevisionSchema.safeParse({
      expectedCaseVersion: 1,
      requestedChange: { requestedByBusinessHandler: true },
      reason: "需重新判责",
      attachmentIds: [],
    }).success).toBe(false);
    expect(CreateExternalResponsibilityRevisionSchema.safeParse({
      expectedCaseVersion: 1,
      requestedChange: {
        kind: "remaining_difference_to_own_factory",
        configurationItemIds: [configurationItemId],
      },
      reason: "供应商拒扣，差额申请转本厂承担",
      attachmentIds: [],
    }).success).toBe(true);
  });

  it("uses real uploads, exact server ledger rules, stable idempotency, UUID routes, and simplified finance actions", async () => {
    const [panel, uploader, uploadHelper, queue, app, css, migration17, migration18, migration19] = await Promise.all([
      readFile(new URL("../../apps/web/src/external-responsibility-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/external-evidence-uploader.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/attachment-upload.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/external-responsibility-queue-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/external-responsibility.css", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0017_external_responsibility_deduction.sql", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0018_external_responsibility_review_closure.sql", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0019_external_revision_seed_ordering.sql", import.meta.url), "utf8"),
    ]);

    expect(panel).toContain("ExternalResponsibilityBatchResponseSchema");
    expect(panel).toContain("ExternalEvidenceUploader");
    expect(panel).toContain("本次扣款金额");
    expect(panel).toContain("重判责任");
    expect(panel).toContain('recorded.remainingAmount === "0.00" && recorded.canClose');
    expect(panel).toContain("seededDeterminationId");
    expect(panel).toContain('"idempotency-key": mutationKey(signature)');
    expect(panel).toContain("pendingMutationKeys.current[signature]");
    expect(panel).toContain("external-responsibility-batches/");
    expect(panel).toContain("external-responsibility-cases/");
    expect(panel).not.toContain("ready 附件 ID");
    expect(panel).not.toContain("parseFloat(");
    expect(panel).not.toMatch(/proposedDeductionAmount\s*[/+*-]/);

    expect(uploader).toContain("tools/attachments/upload-intents");
    const recovery=await readFile(new URL("../../apps/web/src/attachment-upload-recovery.ts",import.meta.url),"utf8");
    expect(uploader).toContain("uploadAttachmentWithRecovery");
    expect(recovery).toContain("sha256Hex");
    expect(uploadHelper).toContain("crypto.subtle.digest");
    expect(uploader).toContain("UploadIntentResponseSchema");
    expect(uploader).toContain("AttachmentResponseSchema");
    expect(uploader).toContain('accept="image/jpeg,image/png,image/webp,application/pdf"');

    expect(queue).toContain('apiUrl("external-responsibilities/queue")');
    expect(queue).toContain("item.reworkOrderId");
    expect(queue).not.toContain("window.setInterval");
    expect(queue).not.toContain('window.addEventListener("focus"');
    expect(app).toContain('path === "/ui/external-responsibilities"');
    expect(css).toContain("@media (max-width: 800px)");
    expect(css).toContain("@media (max-width: 480px)");

    expect(migration17).toContain("rework_external_deduction_entries");
    expect(migration17).toContain("rework_external_deduction_closures");
    expect(migration17).toContain("external responsibility history is append-only");
    expect(migration17).toContain("'completed'");
    expect(migration18).toContain("order_record.merchandiser_user_id=delegation.grantor_user_id");
    expect(migration18).toContain("('embroidery_washing_merchandiser','tools:user')");
    expect(migration18).toContain("external_followups_bump_case_version");
    expect(migration18).toContain("seeded_determination_id");
    expect(migration19).toContain("revision.status IN ('pending','approved')");
  });
});
