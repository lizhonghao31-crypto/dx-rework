import { readFile } from "node:fs/promises";

import {
  DecideSourcingFactoryChangeSchema,
  RequestSourcingFactoryChangeSchema,
  SourcingFactoryChangeStateResponseSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("sourcing role-aware factory change workflow", () => {
  it("validates immutable request, review and current-state contracts", () => {
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

  it("implements all three initiators and the price threshold on the server", async () => {
    const [service, routes] = await Promise.all([
      readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8"),
      readFile("apps/api/src/sourcing/sourcing-routes.ts", "utf8"),
    ]);
    expect(service).toContain('initiatorRole === "owner_group"');
    expect(service).toContain('initiatorRole === "production_management" && !requiresOwnerApproval');
    expect(service).toContain("scaledUnitPrice(unitPrice) > scaledUnitPrice(source.decision_unit_price!)");
    expect(service).toContain('"sourcing.factory_change.management_approved"');
    expect(service).toContain('"sourcing.factory_change.owner_rejected"');
    expect(service).toContain('"sourcing.factory_change.effective"');
    expect(service).toContain("生产管理首次提交选厂信息后才可发起订单转厂");
    expect(routes).toContain('"/sourcing/cases/:sourcingCaseId/factory-changes/management"');
    expect(routes).toContain('"/sourcing/cases/:sourcingCaseId/factory-changes/owner"');
    expect(routes).toContain('"/sourcing/cases/:sourcingCaseId/factory-changes/:factoryChangeRequestId/owner-decision"');
  });

  it("keeps five main nodes, locks transfer before the first decision and excludes finance", async () => {
    const [migration, page] = await Promise.all([
      readFile("apps/api/migrations/0127_sourcing_factory_change_auxiliary.sql", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
    ]);
    expect(migration).toContain("factory_change_effective");
    expect(migration).toContain("requires_owner_approval");
    expect(migration).toContain("decision_role");
    expect(page).toContain('{ key: "finance", number: "05"');
    expect(page).not.toContain('{ key: "contract"');
    expect(page).toContain("生产管理首次提交加工厂和单价后开放");
    expect(page).toContain("订单转厂");
    expect(page).toContain('selectedNode === "created"');
    expect(page).toContain('selectedNode === "management"');
    expect(page).toContain('selectedNode === "owner"');
    expect(page).not.toContain('selectedNode === "finance" ? "factory');
    expect(page).toContain("该模块当前仅开放电脑端");
  });
});
