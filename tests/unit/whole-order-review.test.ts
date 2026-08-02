import { readFile } from "node:fs/promises";

import {
  ConfirmQuantityIncreaseSchema,
  CreateQuantityDecreaseSchema,
  CreateQuantityIncreaseSchema,
  RejectWorkReportSchema,
  ReviewQuantityIncreaseSchema,
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
  });

  it("keeps whole-order transitions explicit and terminal responsibility work out of PR-08", () => {
    expect(transitionReworkOrder("pending_order_review", "pending_responsibility_determination")).toBe("pending_responsibility_determination");
    expect(transitionReworkOrder("pending_order_review", "pending_quantity_adjustment_ie_review")).toBe("pending_quantity_adjustment_ie_review");
    expect(() => transitionReworkOrder("pending_responsibility_determination", "in_progress")).toThrow();
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
  });

  it("keeps the mobile workspace incremental and delegates authorization to the server", async () => {
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    const panel = await readFile(new URL("../../apps/web/src/whole-order-review-panel.tsx", import.meta.url), "utf8");
    expect(form).toContain("WholeOrderReviewPanel");
    expect(form).toContain("const taskReadable");
    expect(form).toContain("reworkOrderId && reviewEligible");
    expect(form).toContain('setReviewEligible(me.status === "authorized")');
    expect(panel).toContain("whole-order-review/approve");
    expect(panel).toContain("quantity-adjustments");
    expect(panel).not.toContain("@mui");
  });
});
