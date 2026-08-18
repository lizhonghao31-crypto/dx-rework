import { readFile } from "node:fs/promises";

import {
  OwnerSignatureCommandSchema,
  ResponsibilityDeterminationResponseSchema,
} from "../../packages/contracts/src/index.js";
import { describe, expect, it } from "vitest";

const id = "00000000-0000-4000-8000-000000000010";

describe("phase-1 N07/N08 close", () => {
  it("keeps N08 approval-only and rejects multiplier adjustments", () => {
    expect(OwnerSignatureCommandSchema.parse({ expectedOrderVersion: 8 }))
      .toEqual({ expectedOrderVersion: 8 });
    expect(OwnerSignatureCommandSchema.safeParse({
      expectedOrderVersion: 8,
      specialMultiplierAdjustments: [{
        configurationItemId: id,
        responsibilityType: "processing_factory",
        multiplier: "1.500",
        reason: "供应商确认的特殊承担倍率",
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

  it("materialises N09 supplier ledgers from the locked N07 multiplier", async () => {
    const [ownerService, panel, migration] = await Promise.all([
      readFile("apps/api/src/rework/responsibility-owner-signature-service.ts", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
      readFile("apps/api/migrations/0061_phase1_owner_multiplier_snapshot.sql", "utf8"),
    ]);
    expect(ownerService).not.toContain("validateSpecialMultiplierAdjustments");
    expect(ownerService).not.toContain("specialMultiplierAdjustments");
    expect(ownerService).toContain("this.external.ensureForFinalized(");
    expect(panel).toContain("外部扣款倍率（默认且最低 1.2）");
    expect(panel).toContain("N08 仅可同意或驳回，不能修改倍率");
    expect(panel).toContain("共同责任记录 / 修改说明（可选）");
    expect(migration).toContain("rework_responsibility_owner_multiplier_adjustments");
    expect(migration).toContain("rework.responsibility.owner_approve");
  });
});
