import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import {
  AllocateExternalSuppliersSchema,
  CloseExternalDeductionCaseSchema,
  CreateExternalDeductionEntrySchema,
  PayablesReturnExternalResponsibilityCaseSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

const id = () => randomUUID();

describe("PR-11 external responsibility contracts and mobile UI", () => {
  it("rejects client money, duplicate allocation coverage, and evidence-free partial closure", () => {
    const externalItemId = id();
    expect(AllocateExternalSuppliersSchema.safeParse({
      expectedBatchVersion: 1,
      allocations: [
        { responsibilityType: "processing_factory", supplierId: id(), externalItemIds: [externalItemId] },
        { responsibilityType: "processing_factory", supplierId: id(), externalItemIds: [externalItemId] },
      ],
    }).success).toBe(false);
    expect(CloseExternalDeductionCaseSchema.safeParse({
      expectedCaseVersion: 1, result: "partial", reason: "供应商拒扣", evidenceAttachmentIds: [],
    }).success).toBe(false);
    expect(CloseExternalDeductionCaseSchema.safeParse({
      expectedCaseVersion: 1, result: "partial", reason: "供应商拒扣", evidenceAttachmentIds: [id()],
    }).success).toBe(false);
    expect(CloseExternalDeductionCaseSchema.safeParse({
      expectedCaseVersion: 1, result: "partial", reason: "供应商拒扣", evidenceAttachmentIds: [id()], remainingDifferenceDisposition: "申请责任重判并转本厂承担",
    }).success).toBe(true);
    expect(PayablesReturnExternalResponsibilityCaseSchema.safeParse({
      expectedCaseVersion: 1, attachmentIds: [],
    }).success).toBe(false);
    expect(CreateExternalDeductionEntrySchema.safeParse({
      expectedCaseVersion: 1, entryType: "deduction", amount: "-1.00", deductedOn: "2026-08-03", attachmentIds: [],
    }).success).toBe(false);
  });

  it("uses server numeric strings, real routes, UUIDs, and focus refresh without browser money arithmetic", async () => {
    const [panel, queue, app, css, migration] = await Promise.all([
      readFile(new URL("../../apps/web/src/external-responsibility-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/external-responsibility-queue-page.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/external-responsibility.css", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0017_external_responsibility_deduction.sql", import.meta.url), "utf8"),
    ]);
    expect(panel).toContain("ExternalResponsibilityBatchResponseSchema");
    expect(panel).toContain('"idempotency-key":crypto.randomUUID()');
    expect(panel).toContain("external-responsibility-batches/");
    expect(panel).toContain("external-responsibility-cases/");
    expect(panel).toContain("processingFactoryOverrideReason");
    expect(panel).toContain("remainingDifferenceDisposition");
    expect(panel).toContain("未扣差额最终处理");
    expect(panel).toContain("通过责任变更");
    expect(panel).not.toContain("parseFloat(");
    expect(panel).not.toMatch(/proposedDeductionAmount\s*[/+*-]/);
    expect(queue).toContain('apiUrl("external-responsibilities/queue")');
    expect(queue).toContain("item.reworkOrderId");
    expect(queue).toContain("window.setInterval");
    expect(queue).toContain('window.addEventListener("focus", refresh)');
    expect(app).toContain('path === "/ui/external-responsibilities"');
    expect(css).toContain("@media (max-width:800px)");
    expect(css).toContain("@media (max-width:480px)");
    expect(migration).toContain("rework_external_deduction_entries");
    expect(migration).toContain("external_responsibility_can_payables");
    expect(migration).toContain("rework_external_deduction_closures");
    expect(migration).toContain("remaining_difference_disposition IS NOT NULL");
    expect(migration).toContain("'deduction adjustment or reversal must reference its own case ledger entry'");
    expect(migration).toContain("external_responsibility_superseded_by_finalization");
    expect(migration).toContain("external responsibility history is append-only");
    expect(migration).toContain("'completed'");
  });
});
