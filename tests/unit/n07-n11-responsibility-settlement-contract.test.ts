import { readFile } from "node:fs/promises";

import {
  OwnerSignatureCommandSchema,
  ReworkOrderStatusSchema,
} from "@dx-rework/contracts";
import {
  DomainRuleError,
  transitionReworkOrder,
} from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

describe("N07–N11 responsibility settlement contract", () => {
  it("allows the main-order N07 → N08 → N10 path and rejects a skipped owner signature", () => {
    expect(transitionReworkOrder(
      "pending_responsibility_determination",
      "pending_owner_signature",
    )).toBe("pending_owner_signature");
    expect(transitionReworkOrder(
      "pending_owner_signature",
      "completed",
    )).toBe("completed");

    expect(() => transitionReworkOrder(
      "pending_responsibility_determination",
      "completed",
    )).toThrow(DomainRuleError);
  });

  it("keeps the owner action versioned and rejects any multiplier mutation", () => {
    expect(OwnerSignatureCommandSchema.parse({ expectedOrderVersion: 8 }))
      .toEqual({ expectedOrderVersion: 8 });
    expect(OwnerSignatureCommandSchema.safeParse({
      expectedOrderVersion: 8,
      specialMultiplierAdjustments: [],
    }).success).toBe(false);
    expect(OwnerSignatureCommandSchema.safeParse({
      expectedOrderVersion: 8,
      reason: "不应要求老板填写理由",
    }).success).toBe(false);
    expect(ReworkOrderStatusSchema.parse("pending_owner_signature"))
      .toBe("pending_owner_signature");
  });

  it("makes every new draft V2 and enforces party facts before server-only N09 materialization", async () => {
    const [service, panel, migration, multiplierGuard, detail, backfill, externalPanel, application, authorized, ownerSignature, finalExternal, external, close] = await Promise.all([
      readFile("apps/api/src/rework/responsibility-determination-service.ts", "utf8"),
      readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8"),
      readFile("apps/api/migrations/0054_n07_n11_responsibility_settlement.sql", "utf8"),
      readFile("apps/api/migrations/0055_responsibility_party_multiplier_guard.sql", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
      readFile("apps/api/src/todos/backfill-service.ts", "utf8"),
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-application-service.ts", "utf8"),
      readFile("apps/api/src/rework/responsibility-determination-authorized-service.ts", "utf8"),
      readFile("apps/api/src/rework/responsibility-owner-signature-service.ts", "utf8"),
      readFile("apps/api/src/rework/final-external-responsibility-service.ts", "utf8"),
      readFile("apps/api/src/rework/external-responsibility-service.ts", "utf8"),
      readFile("apps/api/src/rework/external-responsibility-close-service.ts", "utf8"),
    ]);
    expect(service).toContain("const settlementSchemaVersion = 2 as const");
    expect(service).toContain("外部责任方必须填写实际供应商");
    expect(service).toContain("外部供应商倍率不能低于 1.2");
    expect(panel).toContain("const canEditDetermination");
    expect(panel).toContain("response.ownerSignature?.decision === \"rejected\"");
    expect(panel).toContain("determination?.stage === \"finalized\"");
    expect(panel).toContain('determination.stage === "draft"');
    expect(panel).toContain('const needsSave = determination === null || determination.stage === "finalized" || hasUnsavedChanges');
    expect(migration).toContain("V2 supplier ledger must be server-created from N07 facts");
    expect(multiplierGuard).toContain("COALESCE(allocation.multiplier, process.multiplier)");
    expect(multiplierGuard).toContain("NEW.multiplier IS DISTINCT FROM parent_multiplier");
    expect(migration).toContain("owner signature requires a direct active owner or root");
    expect(migration).toContain("access_is_root_actor(NEW.signed_by)");
    expect(migration).toContain("owner signature must persist the trusted audit context");
    expect(migration).toContain("V2 supplier ledger snapshot is invalid");
    expect(migration).toContain("'rework.responsibility.submit_owner_signature','responsibility:determine'");
    expect(migration).toContain("'pending_owner_signature' AND NEW.status='completed'");
    expect(migration).toContain("WHEN 'rework.responsibility.submit_owner_signature' THEN 'responsibility:determine'");
    expect(migration).toContain("'rework.responsibility.submit_owner_signature'\n    ) THEN");
    expect(detail).toContain("FROM rework_wage_items wage");
    expect(detail).toContain("FROM wage_periods WHERE status<>'locked'");
    expect(detail).toContain("const canViewWagePeriods");
    expect(detail).toContain("unsettledWagePeriods");
    expect(backfill).toContain("'rework.responsibility.submit_owner_signature'");
    expect(backfill).toContain("external-deduction:${row.case_id}:v1");
    expect(backfill).toContain('requiredCapability: isV2Ledger ? "external_deduction:record"');
    expect(backfill).toContain("this.pendingOwnerSignatures(watermark)");
    expect(backfill).toContain('kind: "owner_signature"');
    expect(backfill).toContain("owner-signature:${row.rework_order_id}:${row.determination_version}");
    expect(backfill).toContain('requiredCapability: "responsibility:owner_sign"');
    expect(application).toContain("input.expectedCurrentDeterminationVersion === null");
    expect(application).toContain("handlerUserId: actor.actorId");
    expect(application).toContain("请为初始责任判定选择有权限的处理人");
    expect(authorized).toContain("permission.handlerUserId ?? (");
    expect(authorized).toContain("permission.canDetermine && !isRootActor(actor) ? actor.actorId : null");
    expect(ownerSignature).toContain("await this.external.ensureForFinalized(");
    expect(ownerSignature).toContain("settlement ledgers were generated");
    expect(migration).toContain("SELECT access_is_root_actor(candidate)");
    expect(migration).toContain("Root is a globally authorized actor");
    expect(externalPanel).toContain("const canRecordDeduction = !readOnly && caseItem.canRecordDeduction");
    expect(externalPanel).toContain("|| canRecordDeduction");
    expect(finalExternal).toContain("settlement_schema_version");
    expect(finalExternal).toContain("supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot");
    expect(finalExternal).toContain("`external-deduction:${supersededCase.case_id}:`");
    expect(external).toContain("`external-deduction:${targetCase.case_id}:`");
    expect(external).toContain("`external-deduction:${caseId}:`");
    expect(close).toContain("`external-deduction:${caseId}:`");
  });
});
