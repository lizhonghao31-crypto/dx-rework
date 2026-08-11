import { readFile } from "node:fs/promises";

import {
  CreateReworkDraftSchema,
  MAX_REWORK_ATTACHMENTS,
  CreateWorkReportSchema,
  CreateWorkTaskSchema,
  ReviewProcessConfigurationSchema,
  SaveProcessConfigurationSchema,
  UpdateReworkDraftSchema,
} from "@dx-rework/contracts";
import { transitionReworkOrder } from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

describe("rework initiation contracts", () => {
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

  it("caps one rework order at five evidence attachments", () => {
    const attachmentIds = Array.from({ length: MAX_REWORK_ATTACHMENTS + 1 }, (_value, index) =>
      `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    );
    expect(CreateReworkDraftSchema.safeParse({
      attachmentIds: attachmentIds.slice(0, MAX_REWORK_ATTACHMENTS),
    }).success).toBe(true);
    expect(CreateReworkDraftSchema.safeParse({ attachmentIds }).success).toBe(false);
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

  it("keeps configuration units and IE rejection reasons explicit", () => {
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
    }).success).toBe(true);
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
