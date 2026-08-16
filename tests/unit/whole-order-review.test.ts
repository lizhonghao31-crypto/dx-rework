import { readFile } from "node:fs/promises";

import {
  ConfirmQuantityIncreaseSchema,
  CreateQuantityDecreaseSchema,
  CreateQuantityIncreaseSchema,
  RejectWorkReportSchema,
  ReviewQuantityIncreaseSchema,
  ReviewTailPricingSchema,
  SubmitTailPricingSchema,
  WholeOrderReviewResponseSchema,
} from "../../packages/contracts/src/index.js";
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
    const response = { reworkOrderId: id, reworkStatus: "pending_order_review", orderVersion: 2, canReview: true, canSubmitTailPricing: true, canReviewTailPricing: false, canAdjustQuantity: true, canConfirmQuantity: false, canReviewQuantityIncrease: false, processes: [], reports: [report], adjustments: [], temporaryWorkers: [], tailPricing: null, reviewId: null };
    expect(WholeOrderReviewResponseSchema.safeParse(response).success).toBe(true);
    expect(WholeOrderReviewResponseSchema.safeParse({ ...response, reports: [{ ...report, assignmentMode: undefined }] }).success).toBe(false);
    expect(SubmitTailPricingSchema.safeParse({ expectedOrderVersion: 2, prices: [{ configurationItemId: id, unitPrice: 0.55 }], temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.2, reason: "旺季临时工加价" }] }).success).toBe(true);
    expect(SubmitTailPricingSchema.safeParse({ expectedOrderVersion: 2, prices: [{ configurationItemId: id, unitPrice: 0.555 }], temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.2 }] }).success).toBe(false);
    expect(ReviewTailPricingSchema.safeParse({ expectedOrderVersion: 2, decision: "rejected" }).success).toBe(false);
  });

  it("keeps whole-order transitions explicit and terminal responsibility work out of PR-08", () => {
    expect(transitionReworkOrder("pending_order_review", "pending_responsibility_determination")).toBe("pending_responsibility_determination");
    expect(transitionReworkOrder("pending_order_review", "pending_quantity_adjustment_ie_review")).toBe("pending_quantity_adjustment_ie_review");
    expect(() => transitionReworkOrder("pending_responsibility_determination", "in_progress")).toThrow();
  });

  it("keeps N05 price entry separate from N06 IE approval", async () => {
    const [panel, service, migration] = await Promise.all([
      readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/whole-order-review-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0060_phase1_tail_pricing_ie_review.sql", import.meta.url), "utf8"),
    ]);
    expect(panel).toContain("最终单价与临时工系数");
    expect(panel).toContain("提交 IE 核价");
    expect(panel).toContain("IE 仅审核尾部已经提交的价格与临时工系数；不能在这里修改");
    expect(service).toContain("async submitTailPricing");
    expect(service).toContain("async reviewTailPricing");
    expect(service).toContain("FROM rework_tail_pricing_submissions WHERE rework_order_id=$1");
    expect(service).not.toContain("FROM rework_tail_pricing_submissions WHERE rework_order_id=$1 FOR UPDATE");
    expect(migration).toContain("rework_tail_temporary_wage_coefficients");
    expect(migration).toContain("rework.tail_pricing.ie_approve");
  });

  it("adds only a forward PR-08 migration with immutable rejection and adjustment guards", async () => {
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

  it("keeps the mobile workspace incremental and delegates authorization to the server", async () => {
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    const panel = await readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8");
    expect(form).toContain("WholeOrderReviewPanel");
    expect(form).toContain("const taskReadable");
    expect(form).toContain("reworkOrderId && reviewEligible");
    expect(form).toContain('const orderReviewable = me.status === "authorized" && canReviewOrder(me.user);');
    expect(form).toContain("setReviewEligible(orderReviewable);");
    expect(panel).toContain("whole-order-review/approve");
    expect(panel).toContain("quantity-adjustments");
    expect(panel).toContain('report.assignmentMode === "collective"');
    expect(panel).not.toContain("report.members.length > 1");
    expect(panel).not.toContain("@mui");
  });
});
