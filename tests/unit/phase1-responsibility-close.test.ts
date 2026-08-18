import { readFile } from "node:fs/promises";

import {
  OwnerSignatureCommandSchema,
  ResponsibilityDeterminationResponseSchema,
} from "../../packages/contracts/src/index.js";
import { describe, expect, it } from "vitest";

const id = "00000000-0000-4000-8000-000000000010";

describe("phase-1 N07/N08 close", () => {
  it("accepts only audited non-default external multiplier exceptions", () => {
    expect(OwnerSignatureCommandSchema.parse({ expectedOrderVersion: 8 }))
      .toEqual({ expectedOrderVersion: 8, specialMultiplierAdjustments: [] });
    expect(OwnerSignatureCommandSchema.safeParse({
      expectedOrderVersion: 8,
      specialMultiplierAdjustments: [{
        configurationItemId: id,
        responsibilityType: "processing_factory",
        multiplier: "1.500",
        reason: "供应商确认的特殊承担倍率",
      }],
    }).success).toBe(true);
    expect(OwnerSignatureCommandSchema.safeParse({
      expectedOrderVersion: 8,
      specialMultiplierAdjustments: [{
        configurationItemId: id,
        responsibilityType: "processing_factory",
        multiplier: "1.200",
        reason: "默认倍率不应重复提交",
      }],
    }).success).toBe(false);
  });

  it("keeps multiplier exceptions in the owner-signature response snapshot", () => {
    const response = ResponsibilityDeterminationResponseSchema.safeParse({
      reworkOrderId: id, reworkStatus: "completed", orderVersion: 9,
      handlerUserId: null, canDetermine: false, canTakeover: false,
      canConfirmHighMultiplier: false, canOwnerSign: false,
      ownerSignature: {
        determinationId: id, decision: "approved", signedBy: id,
        signedAt: "2026-08-16T00:00:00.000Z",
        multiplierAdjustments: [{
          configurationItemId: id, responsibilityType: "processing_factory",
          multiplier: "1.500", reason: "供应商确认的特殊承担倍率",
        }],
      },
      sourceProcesses: [], determination: null,
    });
    expect(response.success).toBe(true);
  });

  it("materialises N09 supplier ledgers while preserving N08 multiplier snapshots", async () => {
    const [ownerService, panel, migration] = await Promise.all([
      readFile("apps/api/src/rework/responsibility-owner-signature-service.ts", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
      readFile("apps/api/migrations/0061_phase1_owner_multiplier_snapshot.sql", "utf8"),
    ]);
    expect(ownerService).toContain("validateSpecialMultiplierAdjustments");
    expect(ownerService).toContain("this.external.ensureForFinalized(");
    expect(panel).toContain("特殊外部倍率（默认 1.2）");
    expect(panel).toContain("共同责任记录 / 修改说明（可选）");
    expect(migration).toContain("rework_responsibility_owner_multiplier_adjustments");
    expect(migration).toContain("rework.responsibility.owner_approve");
  });
});
