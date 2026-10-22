import { readFile } from "node:fs/promises";

import {
  DecideSourcingFactoryChangeSchema,
  RequestSourcingFactoryChangeSchema,
  SourcingFactoryChangeStateResponseSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("sourcing role-aware factory change backend", () => {
  it("validates request, approval and current-state contracts", () => {
    expect(RequestSourcingFactoryChangeSchema.safeParse({
      supplierId: "00000000-0000-4000-8000-000000000001",
      unitPrice: "10.5000",
      changeReason: "原厂排期冲突",
    }).success).toBe(true);
    expect(DecideSourcingFactoryChangeSchema.safeParse({
      decision: "approved",
      verificationReason: "产能与交期已核实",
    }).success).toBe(true);
    expect(SourcingFactoryChangeStateResponseSchema.safeParse({ item: {
      factoryChangeRequestId: "00000000-0000-4000-8000-000000000001",
      fromDecisionId: "00000000-0000-4000-8000-000000000002",
      initiatorRole: "production_management",
      proposedSupplierId: "00000000-0000-4000-8000-000000000003",
      proposedSupplierName: "二号加工厂",
      proposedUnitPrice: "10.5000",
      proposedQuantity: 1000,
      proposedTotalAmount: "10500.00",
      changeReason: "原厂排期冲突",
      requiresOwnerApproval: false,
      status: "effective",
      requestedBy: "00000000-0000-4000-8000-000000000004",
      requestedAt: "2026-08-31T00:00:00.000Z",
    } }).success).toBe(true);
  });

  it("implements the three initiators, threshold routing and finance pause server-side", async () => {
    const [service, routes, migration] = await Promise.all([
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-routes.ts", "utf8"),
      readFile("apps/api/migrations/0128_sourcing_factory_change_workflow.sql", "utf8"),
    ]);
    expect(service).toContain('initiatorRole === "owner_group"');
    expect(service).toContain('initiatorRole === "production_management" && !requiresOwnerApproval');
    expect(service).toContain("requiresSourcingPriceOwnerApproval(unitPrice,source.decision_unit_price!)");
    expect(service).toContain("scaledUnitPrice(proposed)>scaledUnitPrice(basis)");
    expect(service).toContain('"sourcing.factory_change.management_approved"');
    expect(service).toContain('"sourcing.factory_change.owner_rejected"');
    expect(service).toContain('"sourcing.factory_change.effective"');
    expect(service).toContain("生产管理首次提交选厂信息后才可发起订单转厂");
    expect(service).toContain("订单转厂审批中，财务暂不能核对");
    expect(routes).toContain('"/sourcing/cases/:sourcingCaseId/factory-changes/management"');
    expect(routes).toContain('"/sourcing/cases/:sourcingCaseId/factory-changes/owner"');
    expect(routes).toContain('"/sourcing/cases/:sourcingCaseId/factory-changes/:factoryChangeRequestId/owner-decision"');
    expect(migration).toContain("sourcing_factory_change_decisions_request_role_key");
    expect(migration).toContain("guard_sourcing_reconciliation_without_open_factory_change");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION guard_sourcing_owner_decision_insert()");
    expect(migration).not.toContain("OR current_decision.source_type='factory_change'");
    expect(migration).not.toContain("ADD COLUMN initiator_role");
  });

  it("keeps the backend PR free of PC and mobile implementation changes", async () => {
    const service = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    expect(service).not.toContain("移动端报价选厂");
    expect(service).not.toContain("sourcing-workspace-page");
  });
});
