import { readFile } from "node:fs/promises";

import {
  CreateReworkDraftSchema,
  InspectionReportDraftSchema,
  InspectionReportSchema,
  type InspectionReportDraft,
  MAX_REWORK_ATTACHMENTS,
  CreateWorkReportSchema,
  CreateWorkReportsBatchSchema,
  CreateWorkTaskSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  SupplementReworkOrderImagesSchema,
  UpdateReworkDraftSchema,
} from "@dx-rework/contracts";
import { transitionReworkOrder } from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

describe("rework initiation contracts", () => {
  const completeInspectionReport = (): InspectionReportDraft => ({
    schemaVersion: 1 as const,
    styleName: "测试款式",
    inspectionStage: "final" as const,
    inspectionLocation: "一厂验货区",
    color: "藏青",
    sampleQuantity: 1,
    measurementUnit: "cm" as const,
    measurementPrecision: 0.1 as const,
    sizeSamples: [{
      sampleId: "00000000-0000-4000-8000-000000000201",
      sizeLabel: "M",
      sampleLabel: "第 1 件",
      measurements: [{ partName: "衣长", actualCm: 68.2, deviationCm: -0.3, notApplicable: false }],
    }],
    documentChecks: {
      confirmationSample: true,
      approvalCard: true,
      supplierSelfInspection: true,
      bulkFabricInspection: true,
      exceptionReason: null,
    },
    fabricMatch: "match" as const,
    fabricMismatchReason: null,
    fitDecision: "recheck_after_rework" as const,
    factoryPreparation: "strict" as const,
    materialChecks: { physicalPerformance: "pass" as const, washTest: "pass" as const, productMarking: "pass" as const },
    issues: [{
      issueId: "00000000-0000-4000-8000-000000000202",
      category: "袖口",
      description: "尺寸偏小",
      majorCount: 1,
      minorCount: 0,
    }],
    nonconformanceCause: "车缝控制偏差",
    approvalOpinion: null,
    supplierSignatoryName: null,
    supplierSignedOn: null,
    inspectionDate: "2026-08-14",
    disposition: "rework" as const,
  });

  it("allows incomplete drafts while keeping one strict style field", () => {
    expect(CreateReworkDraftSchema.safeParse({}).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({ styleNo: "PD20529725" }).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({
      styleNo: "PD20529725",
      styleNos: ["PD20529725", "PD20529726"],
    }).success).toBe(false);
  });

  it("captures the complete initiation context while keeping quantities integral", () => {
    expect(CreateReworkDraftSchema.safeParse({
      customerSupplyCode: "CUST-001",
      factoryStyleNo: "FAC-001",
      orderQuantity: 100,
      reworkReason: "抽检发现车缝不良",
      reworkProcess: "车缝, 后整",
    }).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({ orderQuantity: 1.5 }).success).toBe(false);
  });

  it("persists incomplete inspection drafts but validates a complete 0.1 cm report on submit", () => {
    const draft = completeInspectionReport();
    draft.inspectionStage = null;
    expect(InspectionReportDraftSchema.safeParse(draft).success).toBe(true);
    expect(InspectionReportSchema.safeParse(draft).success).toBe(false);

    const complete = completeInspectionReport();
    expect(InspectionReportSchema.safeParse(complete).success).toBe(true);
    expect(InspectionReportSchema.safeParse({
      ...complete,
      sizeSamples: [{
        ...complete.sizeSamples[0],
        measurements: [{ partName: "衣长", actualCm: 68.25, deviationCm: -0.3, notApplicable: false }],
      }],
    }).success).toBe(false);
  });

  it("rejects invalid quantities, duplicate attachments and ambiguous factories", () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    expect(UpdateReworkDraftSchema.safeParse({
      expectedVersion: 1,
      reworkQuantity: 1.5,
    }).success).toBe(false);
    expect(UpdateReworkDraftSchema.safeParse({
      expectedVersion: 1,
      attachmentIds: [attachmentId, attachmentId],
    }).success).toBe(false);
    expect(UpdateReworkDraftSchema.safeParse({
      expectedVersion: 1,
      processingFactory: {
        type: "own_factory",
        supplierId: "00000000-0000-4000-8000-000000000002",
      },
    }).success).toBe(false);
  });

  it("caps one rework order at eight unified attachments", () => {
    expect(MAX_REWORK_ATTACHMENTS).toBe(8);
    const attachmentIds = Array.from({ length: MAX_REWORK_ATTACHMENTS + 1 }, (_value, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    expect(CreateReworkDraftSchema.safeParse({
      attachmentIds: attachmentIds.slice(0, MAX_REWORK_ATTACHMENTS),
    }).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({ attachmentIds }).success).toBe(false);
  });

  it("keeps the detail image region at six visible slots while all eight remain previewable", async () => {
    const source = await readFile(
      new URL("../../apps/web/src/rework-detail-page.tsx", import.meta.url),
      "utf8",
    );
    expect(source).toContain("const visibleImageAttachments = imageAttachments;");
    expect(source).toContain("index === 5 && imageAttachments.length > 6");
    expect(source).toContain("imageAttachments.length - 5");
  });

  it("requires a non-empty, unique, capped image supplement batch", () => {
    const attachmentId = "00000000-0000-4000-8000-000000000001";
    const attachmentIds = Array.from({ length: MAX_REWORK_ATTACHMENTS + 1 }, (_value, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    expect(SupplementReworkOrderImagesSchema.safeParse({
      expectedVersion: 1,
      attachmentIds: [attachmentId],
    }).success).toBe(true);
    expect(SupplementReworkOrderImagesSchema.safeParse({
      expectedVersion: 1,
      attachmentIds: [],
    }).success).toBe(false);
    expect(SupplementReworkOrderImagesSchema.safeParse({
      expectedVersion: 1,
      attachmentIds: [attachmentId, attachmentId],
    }).success).toBe(false);
    expect(SupplementReworkOrderImagesSchema.safeParse({
      expectedVersion: 1,
      attachmentIds,
    }).success).toBe(false);
  });

  it("keeps role-based supplements inside the database audit boundary", async () => {
    const source = await readFile(
      new URL("../../apps/api/migrations/0103_role_based_rework_image_supplement.sql", import.meta.url),
      "utf8",
    );
    expect(source).toContain("expected_action:='rework.attachments.supplement'; expected_capability:='tools:user'");
    expect(source).toContain("order_status NOT IN ('cancelled','deleted')");
    expect(source).toContain("event.authorization_capability='tools:user'");
    expect(source).not.toContain("OLD.status IN ('completed','cancelled','deleted')");
  });

  it("permits the PR-05/06 state transitions without unlocking later nodes", () => {
    expect(transitionReworkOrder("draft", "pending_process_configuration"))
      .toBe("pending_process_configuration");
    expect(transitionReworkOrder("pending_process_configuration", "draft"))
      .toBe("draft");
    expect(transitionReworkOrder("pending_process_configuration", "pending_ie_review"))
      .toBe("pending_ie_review");
    expect(transitionReworkOrder("pending_ie_review", "pending_task_assignment"))
      .toBe("pending_task_assignment");
    expect(() => transitionReworkOrder("pending_task_assignment", "draft"))
      .toThrowError(/Cannot transition/);
    expect(transitionReworkOrder("draft", "cancelled")).toBe("cancelled");
    expect(() => transitionReworkOrder("cancelled", "draft"))
      .toThrowError(/Cannot transition/);
  });

  it("limits new configurations to piece counts and keeps IE rejection reasons explicit", () => {
    expect(SaveProcessConfigurationSchema.safeParse({
      expectedOrderVersion: 2,
      items: [{
        source: "custom",
        customProcessName: "特殊翻边返修",
        pricingUnit: "piece",
        plannedQuantity: 12,
        unitPrice: 0.55,
      }],
    }).success).toBe(true);
    expect(SaveProcessConfigurationSchema.safeParse({
      expectedOrderVersion: 2,
      items: [{
        source: "custom",
        customProcessName: "特殊翻边返修",
        pricingUnit: "hour",
        plannedQuantity: 1.2,
        unitPrice: 0.55,
      }],
    }).success).toBe(false);
    expect(ReviewProcessConfigurationSchema.safeParse({
      expectedOrderVersion: 2,
      expectedConfigurationVersion: 1,
      decision: "rejected",
    }).success).toBe(false);
  });

  it("keeps PR-06 migration guards separate from historical migrations", async () => {
    const migration = await readFile(
      new URL("../../apps/api/migrations/0007_process_configuration_ie_review.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("rework_process_configurations");
    expect(migration).toContain("rework_process_configuration_items");
    expect(migration).toContain("rework_custom_process_promotions");
    expect(migration).toContain("pending_task_assignment");
    expect(migration).toContain("process configuration identity and business fields are immutable");
    expect(migration).toContain("custom process catalog promotion requires approved IE audit context");
    expect(migration).not.toMatch(/ALTER TABLE\s+.*000[1-6]/i);
  });

  it("enforces individual versus collective task snapshots and structural report input", () => {
    const personId = "00000000-0000-4000-8000-000000000010";
    const itemId = "00000000-0000-4000-8000-000000000011";
    expect(CreateWorkTaskSchema.safeParse({ expectedOrderVersion: 1, configurationItemId: itemId, mode: "individual", members: [{ personId }] }).success).toBe(true);
    expect(CreateWorkTaskSchema.safeParse({ expectedOrderVersion: 1, configurationItemId: itemId, mode: "individual", members: [{ personId }, { personId: "00000000-0000-4000-8000-000000000012" }] }).success).toBe(false);
    expect(CreateWorkTaskSchema.safeParse({ expectedOrderVersion: 1, configurationItemId: itemId, mode: "collective", members: [{ personId }, { personId }] }).success).toBe(false);
    expect(CreateWorkReportSchema.safeParse({ expectedOrderVersion: 1, actualQuantity: 1.2, completedAt: "2026-08-02T12:00:00.000Z" }).success).toBe(true);
    expect(CreateWorkReportSchema.safeParse({ expectedOrderVersion: 1, actualQuantity: 1.2, completedAt: "2026-08-02T12:00:00.000Z", remark: "   " }).success).toBe(false);
    const reports = Array.from({ length: 50 }, (_, index) => ({
      workTaskId: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      actualQuantity: 5_000 + index,
    }));
    expect(CreateWorkReportsBatchSchema.safeParse({ expectedOrderVersion: 1, reports }).success).toBe(true);
    expect(CreateWorkReportsBatchSchema.safeParse({
      expectedOrderVersion: 1,
      reports: [reports[0], reports[0]],
    }).success).toBe(false);
    expect(CreateWorkReportsBatchSchema.safeParse({
      expectedOrderVersion: 1,
      reports: Array.from({ length: 201 }, (_, index) => ({
        workTaskId: `00000000-0000-4000-8001-${String(index + 20).padStart(12, "0")}`,
        actualQuantity: 5_000,
      })),
    }).success).toBe(false);
  });

  it("keeps historical PR-07 storage intact while the practical precision migration governs new writes", async () => {
    const historical = await readFile(new URL("../../apps/api/migrations/0008_worker_assignment_reporting.sql", import.meta.url), "utf8");
    expect(historical).toContain("rework_work_tasks");
    expect(historical).toContain("rework_work_task_members");
    expect(historical).toContain("rework_work_reports");
    expect(historical).toContain("rework_work_report_member_shares");
    expect(historical).toContain("work:report_for_worker");
    expect(historical).toContain("pending_order_review");
    expect(historical).toContain("rework_work_tasks_external_source_idx");
    expect(historical).toContain("rework_work_reports_external_source_idx");

    const practical = await readFile(new URL("../../apps/api/migrations/0039_practical_quantity_amount_precision.sql", import.meta.url), "utf8");
    expect(practical).toContain("planned_quantity = trunc(planned_quantity, 1)");
    expect(practical).toContain("unit_price >= 0.01");
    expect(practical).toContain("unit_price = trunc(unit_price, 2)");
    expect(practical).toContain("actual_quantity = trunc(actual_quantity, 1)");
    expect(practical).toContain("group_amount = trunc(group_amount, 3)");
    expect(practical).toContain("amount = trunc(amount, 3)");
    expect(practical).toContain("requested_planned_quantity = trunc(requested_planned_quantity, 1)");
    expect(practical).toContain("actual_cut_quantity = trunc(actual_cut_quantity, 1)");
    expect(practical).toContain("actual_return_quantity = trunc(actual_return_quantity, 1)");
    expect(practical).toContain("allowed_maximum_quantity = trunc(allowed_maximum_quantity, 1)");
  });

  it("keeps migration-level audit, attachment and identity guards", async () => {
    const migration = await readFile(
      new URL("../../apps/api/migrations/0006_rework_initiation.sql", import.meta.url),
      "utf8",
    );
    expect(migration).toContain("next_rework_order_number");
    expect(migration).toContain("rework_orders_external_source_idx");
    expect(migration).toContain("attachments_rework_binding_guard");
    expect(migration).toContain("attachments_rework_no_delete");
    expect(migration).toContain("bound rework evidence is immutable");
    expect(migration).toContain("rework order write requires trusted audit context");
    expect(migration).toContain("allocated rework number is immutable");
    expect(migration).not.toMatch(/ALTER TABLE\s+.*000[1-5]/i);
  });
});
