import { readFile } from "node:fs/promises";

import {
  ConfirmQuantityIncreaseSchema,
  CorrectWorkReportQuantitiesSchema,
  CorrectWorkReportQuantitySchema,
  CreateQuantityDecreaseSchema,
  CreateQuantityIncreaseSchema,
  RejectWorkReportSchema,
  ReviewFinalQuantitySchema,
  ReviewQuantityIncreaseSchema,
  ReviewWholeOrderSchema,
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
    const report = { workReportId: id, workTaskId: id, configurationItemId: id, actualQuantity: 1, effectiveQuantity: 1, corrected: false, correctionVersion: null, correctedBy: null, correctedAt: null, completedAt: "2026-08-03T00:00:00.000Z", submittedBy: id, assignmentMode: "collective", executionKind: "worker", members: [{ personId: id, displayName: "成员" }], rejected: true, rejectedPersonId: null, rejectionReason: "整条驳回", resubmitsWorkReportId: null };
    const response = { reworkOrderId: id, reworkStatus: "pending_order_review", orderVersion: 2, canReview: true, canIeReview: false, canAdjustQuantity: true, canConfirmQuantity: false, canReviewQuantityIncrease: false, processes: [], reports: [report], adjustments: [], temporaryWorkers: [], reviewId: null, finalConfirmation: null };
    expect(WholeOrderReviewResponseSchema.safeParse(response).success).toBe(true);
    expect(WholeOrderReviewResponseSchema.safeParse({ ...response, reports: [{ ...report, assignmentMode: undefined }] }).success).toBe(false);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, processPrices: [{ configurationItemId: id, unitPrice: 1.234 }], temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.2, reason: "旺季临时工加价" }] }).success).toBe(true);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, processPrices: [{ configurationItemId: id, unitPrice: 1.2345 }], temporaryCoefficients: [] }).success).toBe(false);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, processPrices: [{ configurationItemId: id, unitPrice: 1 }, { configurationItemId: id, unitPrice: 2 }], temporaryCoefficients: [] }).success).toBe(false);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, temporaryCoefficients: [{ configurationItemId: id, personId: id, multiplier: 1.2 }] }).success).toBe(false);
    expect(ReviewWholeOrderSchema.safeParse({ expectedOrderVersion: 2, finalQuantities: [{ configurationItemId: id, finalConfirmedQuantity: 1 }], temporaryCoefficients: [] }).success).toBe(false);
    expect(CorrectWorkReportQuantitySchema.safeParse({ expectedOrderVersion: 2, effectiveQuantity: 4800 }).success).toBe(true);
    expect(CorrectWorkReportQuantitySchema.safeParse({ expectedOrderVersion: 2, effectiveQuantity: 4800.5 }).success).toBe(false);
    expect(CorrectWorkReportQuantitiesSchema.safeParse({
      expectedOrderVersion: 2,
      configurationItemId: id,
      corrections: [
        { workReportId: id, effectiveQuantity: 4800 },
        { workReportId: "00000000-0000-4000-8000-000000000011", effectiveQuantity: 4799 },
      ],
    }).success).toBe(true);
    expect(CorrectWorkReportQuantitiesSchema.safeParse({
      expectedOrderVersion: 2,
      configurationItemId: id,
      corrections: [
        { workReportId: id, effectiveQuantity: 4800 },
        { workReportId: id, effectiveQuantity: 4799 },
      ],
    }).success).toBe(false);
  });

  it("keeps whole-order transitions explicit and terminal responsibility work out of PR-08", () => {
    expect(transitionReworkOrder("pending_order_review", "pending_final_quantity_ie_review")).toBe("pending_final_quantity_ie_review");
    expect(transitionReworkOrder("pending_final_quantity_ie_review", "pending_responsibility_determination")).toBe("pending_responsibility_determination");
    expect(transitionReworkOrder("pending_final_quantity_ie_review", "pending_order_review")).toBe("pending_order_review");
    expect(transitionReworkOrder("pending_order_review", "pending_quantity_adjustment_ie_review")).toBe("pending_quantity_adjustment_ie_review");
    expect(() => transitionReworkOrder("pending_responsibility_determination", "in_progress")).toThrow();
  });

  it("uses N03-approved prices and requires N06 IE review before responsibility", async () => {
    const [panel, service, migration] = await Promise.all([
      readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/whole-order-review-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0065_ie_pricing_before_assignment.sql", import.meta.url), "utf8"),
    ]);
    expect(panel).toContain("确认数量并提交 IE");
    expect(panel).toContain("临时工实发系数");
    expect(panel).toContain("IE 复核决定");
    expect(panel).not.toContain("沿用原价");
    expect(panel).toContain("ieStage && reviewedPrice?.changed");
    expect(panel).toContain(">同意</button>");
    expect(panel).toContain(">驳回</button>");
    expect(panel).toContain('className="quantity-price-decision__button is-approve"');
    expect(panel).toContain('className="quantity-price-decision__button is-reject"');
    expect(panel).toContain("data.canIeReview && <div className=\"quantity-price-decision\"");
    expect(panel).toContain("allChangedPricesDecided");
    expect(panel).toContain('priceReviewDecisions[id] === "approved" || priceReviewDecisions[id] === "rejected"');
    expect(panel).not.toContain("changedPriceIds.length === 0 || anyPriceRejected");
    expect(panel).toContain("系统按各工序有效数量生成最终数量；价格提案与数量一并交 IE 复核。");
    expect(panel).toContain('const failure = describeRequestFailure(cause, "IE 复核失败");');
    expect(panel).toContain('await alertInApp(failure, { title: "IE 复核失败", confirmLabel: "知道了" });');
    expect(panel).toContain("body?.error?.requestId");
    expect(service).not.toContain("async submitTailPricing");
    expect(service).not.toContain("async reviewTailPricing");
    expect(service).toContain('this.orderAudit(order, "pending_final_quantity_ie_review"');
    expect(service).toContain("async reviewFinalQuantity");
    expect(service).toContain("ELSE 1\n                    END,\n                    3\n                  ) AS amount");
    expect(service).not.toContain("ELSE 1\n                    END,\n                    8\n                  ) AS amount");
    expect(ReviewFinalQuantitySchema.safeParse({ expectedOrderVersion: 2, decision: "rejected" }).success).toBe(false);
    expect(migration).toContain("rework_tail_completion_coefficients");
    expect(migration).toContain("rework.whole_order.approve");
    expect(migration).not.toContain("rework.tail_pricing.ie_approve");
  });

  it("keeps N05 prices pending until the N06 IE decision", async () => {
    const [service, migration] = await Promise.all([
      readFile(new URL("../../apps/api/src/rework/whole-order-review-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0129_n05_price_ie_reapproval.sql", import.meta.url), "utf8"),
    ]);
    expect(service).toContain("rework_tail_completion_prices");
    expect(service).toContain("price_snapshot_required");
    expect(service.indexOf("INSERT INTO rework_tail_completion_reviews")).toBeLessThan(
      service.indexOf("UPDATE rework_process_configuration_items item"),
    );
    expect(migration).toContain("process price can only change to the IE-approved N05 proposal");
    expect(migration).toContain("IE-approved final prices must exactly cover the active process configuration");
    expect(migration).toContain("rework_tail_completion_prices_no_update");
    expect(migration).toContain("rework_tail_completion_prices_no_delete");
    expect(migration).toContain("rework_tail_completion_prices_no_truncate");
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
    expect(form).toContain("const orderReviewable = canReviewOrder(session.user);");
    expect(form).toContain("setReviewEligible(orderReviewable);");
    expect(panel).toContain("whole-order-review/approve");
    expect(panel).not.toContain("quantity-adjustments");
    expect(panel).toContain('report.assignmentMode === "individual"');
    expect(panel).not.toContain("report.members.length > 1");
    expect(panel).not.toContain("@mui");
  });
});
