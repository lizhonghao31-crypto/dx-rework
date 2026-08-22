import { readFile } from "node:fs/promises";

import {
  ConfirmQuantityIncreaseSchema,
  CreateQuantityDecreaseSchema,
  CreateQuantityIncreaseSchema,
  RejectWorkReportSchema,
  ReviewWholeOrderSchema,
  ReviewQuantityIncreaseSchema,
  WholeOrderReviewResponseSchema,
} from "../../packages/contracts/src/index.js";
import {
  CreateCompletionConfirmationSchema,
  ReviewCompletionIeSchema,
} from "../../packages/contracts/src/completion-review.js";
import { transitionReworkOrder } from "../../packages/domain/src/index.js";
import { describe, expect, it } from "vitest";

const id = "00000000-0000-4000-8000-000000000010";

describe("whole-order review contracts", () => {
  it("requires stable versions, reasons, confirmation evidence and non-self-service payloads", () => {
    expect(RejectWorkReportSchema.safeParse({ expectedOrderVersion: 2, rejectedPersonId: id, reason: "漏检" }).success).toBe(true);
    expect(RejectWorkReportSchema.safeParse({ expectedOrderVersion: 2, rejectedPersonId: id, reason: " " }).success).toBe(false);
    expect(CreateQuantityDecreaseSchema.safeParse({ expectedOrderVersion: 2, configurationItemId: id, newPlannedQuantity: 2, reason: "实裁调整" }).success).toBe(true);
    expect(CreateQuantityIncreaseSchema.safeParse({ expectedOrderVersion: 2, configurationItemId: id, newPlannedQuantity: 3, reason: "补料", expiresAt: "2026-08-04T00:00:00.000Z" }).success).toBe(true);
    expect(ConfirmQuantityIncreaseSchema.safeParse({ expectedOrderVersion: 2, expectedAdjustmentVersion: 1, decision: "rejected", actualCutQuantity: 3, actualReturnQuantity: 3, allowedMaximumQuantity: 3 }).success).toBe(false);
    expect(ReviewQuantityIncreaseSchema.safeParse({ expectedOrderVersion: 2, expectedAdjustmentVersion: 1, decision: "rejected" }).success).toBe(false);
    const report = { workReportId: id, workTaskId: id, configurationItemId: id, actualQuantity: 1, completedAt: "2026-08-03T00:00:00.000Z", submittedBy: id, assignmentMode: "collective", members: [{ personId: id, displayName: "成员" }], rejected: true, rejectedPersonId: null, rejectionReason: "整条驳回", resubmitsWorkReportId: null };
    const response = { reworkOrderId: id, reworkStatus: "pending_order_review", orderVersion: 2, canReview: true, canAdjustQuantity: true, canConfirmQuantity: false, canReviewQuantityIncrease: false, processes: [], reports: [report], adjustments: [], temporaryWorkers: [], reviewId: null };
    expect(WholeOrderReviewResponseSchema.safeParse(response).success).toBe(true);
    expect(WholeOrderReviewResponseSchema.safeParse({ ...response, reports: [{ ...report, assignmentMode: undefined }] }).success).toBe(false);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.2, reason: "旺季临时工加价" }] }).success).toBe(true);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.2 }] }).success).toBe(false);
  });

  it("splits tail final confirmation from IE result review in the domain state machine", () => {
    expect(transitionReworkOrder("pending_order_review", "pending_completion_ie_review")).toBe("pending_completion_ie_review");
    expect(transitionReworkOrder("pending_completion_ie_review", "pending_responsibility_determination")).toBe("pending_responsibility_determination");
    expect(transitionReworkOrder("pending_completion_ie_review", "pending_order_review")).toBe("pending_order_review");
    expect(() => transitionReworkOrder("pending_order_review", "pending_responsibility_determination")).toThrow();
    expect(transitionReworkOrder("pending_order_review", "pending_quantity_adjustment_ie_review")).toBe("pending_quantity_adjustment_ie_review");
  });

  it("requires complete final quantities and keeps IE review separate from repricing", async () => {
    expect(CreateCompletionConfirmationSchema.safeParse({
      expectedOrderVersion: 2,
      finalQuantities: [{ configurationItemId: id, finalConfirmedQuantity: 12.5 }],
      temporaryCoefficients: [],
    }).success).toBe(true);
    expect(CreateCompletionConfirmationSchema.safeParse({
      expectedOrderVersion: 2,
      finalQuantities: [
        { configurationItemId: id, finalConfirmedQuantity: 12.5 },
        { configurationItemId: id, finalConfirmedQuantity: 12.5 },
      ],
      temporaryCoefficients: [],
    }).success).toBe(false);
    expect(ReviewCompletionIeSchema.safeParse({ expectedOrderVersion: 3, decision: "approved" }).success).toBe(true);
    expect(ReviewCompletionIeSchema.safeParse({ expectedOrderVersion: 3, decision: "rejected", reason: "数量与尾查事实不一致" }).success).toBe(true);

    const [panel, service, migration] = await Promise.all([
      readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/completion-review-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0080_tail_completion_ie_review.sql", import.meta.url), "utf8"),
    ]);
    expect(panel).toContain("最终确认数量");
    expect(panel).toContain("确认最终数量并提交 IE");
    expect(panel).toContain("数量与质量复核通过");
    expect(panel).toContain("不重新核价");
    expect(service).toContain('"pending_completion_ie_review"');
    expect(service).toContain('"pending_responsibility_determination"');
    expect(service).toContain("applyFinalWages");
    expect(migration).toContain("rework_final_completion_confirmations");
    expect(migration).toContain("rework_completion_ie_reviews");
    expect(migration).toContain("rework.completion_ie_review.approve");
  });

  it("keeps immutable rejection and quantity-adjustment guards from the earlier whole-order foundation", async () => {
    const migration = await readFile(new URL("../../apps/api/migrations/0009_whole_order_review_quantity_adjustment.sql", import.meta.url), "utf8");
    expect(migration).toContain("rework_work_report_rejections");
    expect(migration).toContain("rework_process_quantity_adjustments");
    expect(migration).toContain("rework_order_reviews");
    expect(migration).toContain("pending_responsibility_determination");
    expect(migration).toContain("quantity:confirm");
    expect(migration).toContain("rework_work_report_rejections_no_update");
    expect(migration).toContain("rework_process_quantity_adjustments_guard_update");
    expect(migration).toContain("rework_process_quantity_adjustments_no_delete");
    expect(migration).toContain("rework.whole_order.approve");
    expect(migration).toContain("task.assignment_mode='collective'");
    expect(migration).toContain("pg_advisory_xact_lock(hashtext('dx_rework:quantity-adjustment:'");
    expect(migration).toContain("NEW.expires_at IS NULL OR NEW.expires_at<=CURRENT_TIMESTAMP");
    expect(migration).toContain("order has no approved process");
    expect(migration).toContain("order is not pending whole-order review");
  });

  it("keeps the mobile workspace incremental and delegates N07/N08 authorization to the server", async () => {
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    const panel = await readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8");
    expect(form).toContain("WholeOrderReviewPanel");
    expect(form).toContain("const taskReadable");
    expect(form).toContain("reworkOrderId && reviewEligible");
    expect(form).toContain('const orderReviewable = me.status === "authorized" && canReviewOrder(me.user);');
    expect(form).toContain("setReviewEligible(orderReviewable);");
    expect(panel).toContain("completion-confirmation");
    expect(panel).toContain("completion-ie-review");
    expect(panel).not.toContain("quantity-adjustments");
    expect(panel).toContain('report.assignmentMode === "collective"');
    expect(panel).not.toContain("report.members.length > 1");
    expect(panel).not.toContain("@mui");
  });
});
