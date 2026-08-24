import { readFile } from "node:fs/promises";

import {
  CreateResponsibilityDraftSchema,
  OwnerSignatureCommandSchema,
  ReviewWholeOrderSchema,
  SaveProcessConfigurationSchema,
} from "@dx-rework/contracts";
import { transitionReworkOrder } from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

const id = "00000000-0000-4000-8000-000000000010";

describe("IE pricing before assignment invariants", () => {
  it("requires the N02 price and forbids bypassing N03", () => {
    const base = {
      expectedOrderVersion: 2,
      items: [{
        source: "custom" as const,
        customProcessName: "车缝返修",
        plannedQuantity: 10,
        pricingUnit: "piece" as const,
      }],
    };
    expect(SaveProcessConfigurationSchema.safeParse(base).success).toBe(false);
    expect(SaveProcessConfigurationSchema.safeParse({
      ...base,
      items: [{ ...base.items[0], unitPrice: 2 }],
    }).success).toBe(true);
    expect(() => transitionReworkOrder(
      "pending_process_configuration",
      "pending_task_assignment",
    )).toThrow();
    expect(transitionReworkOrder(
      "pending_process_configuration",
      "pending_ie_review",
    )).toBe("pending_ie_review");
  });

  it("keeps temporary wages and external deductions as two separate layers", () => {
    expect(ReviewWholeOrderSchema.safeParse({
      expectedOrderVersion: 8,
      temporaryCoefficients: [{
        configurationItemId: id,
        personId: id,
        multiplier: 1,
      }],
    }).success).toBe(true);
    expect(ReviewWholeOrderSchema.safeParse({
      expectedOrderVersion: 8,
      temporaryCoefficients: [{
        configurationItemId: id,
        personId: id,
        multiplier: 1.3,
        reason: "旺季临时工加价",
      }],
    }).success).toBe(true);

    const responsibility = CreateResponsibilityDraftSchema.parse({
      expectedOrderVersion: 9,
      expectedCurrentDeterminationVersion: null,
      handlerUserId: id,
      processes: [{
        configurationItemId: id,
        multiplier: "1.000",
        allocations: [{
          responsibilityType: "processing_factory",
          shareBps: 10000,
          multiplier: "1.500",
          supplierId: id,
        }],
      }],
    });
    expect(responsibility.processes[0]?.allocations).toHaveLength(1);
    expect(CreateResponsibilityDraftSchema.safeParse({
      ...responsibility,
      processes: [{ ...responsibility.processes[0], multiplier: "1.300", highMultiplierReason: "旧责任系数" }],
    }).success).toBe(false);
    expect(2 * 10 * 1.3).toBe(26);
    expect((2 * 10 * 1.3) * 1.5).toBe(39);
  });

  it("makes N08 approval-only and removes the retired runtime tail-pricing path", async () => {
    expect(OwnerSignatureCommandSchema.safeParse({ expectedOrderVersion: 10 }).success).toBe(true);
    expect(OwnerSignatureCommandSchema.safeParse({
      expectedOrderVersion: 10,
      specialMultiplierAdjustments: [],
    }).success).toBe(false);

    const [routes, service, migration] = await Promise.all([
      readFile("apps/api/src/rework/whole-order-review-routes.ts", "utf8"),
      readFile("apps/api/src/rework/whole-order-review-service.ts", "utf8"),
      readFile("apps/api/migrations/0065_ie_pricing_before_assignment.sql", "utf8"),
    ]);
    expect(routes).not.toContain("tail-pricing");
    expect(service).not.toContain("submitTailPricing");
    expect(service).not.toContain("reviewTailPricing");
    expect(migration).not.toContain("rework.tail_pricing.ie_approve");
    expect(migration).toContain("OLD.status='pending_order_review' AND NEW.status='pending_responsibility_determination'");
  });
});
