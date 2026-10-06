import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { DispatchSourcingOrderSchema, SourcingDispatchStateSchema, SourcingProductionOrderSchema } from "@dx-rework/contracts";
import { SourcingProductionService } from "../../apps/api/src/sourcing/sourcing-production-service.js";

const actor = (role: string, capability = "sourcing:view") => ({
  actorId: randomUUID(), actorRoles: [role], authorizationCapability: capability,
  authorizationCapabilities: [capability], requestId: randomUUID(),
});

describe("SSP-06 production contract and authorization", () => {
  it("accepts old dispatch responses without inferring a digital mode from denied permission", () => {
    expect(SourcingDispatchStateSchema.parse({ item: null, canDispatch: false }).dispatchMode).toBeUndefined();
    expect(SourcingDispatchStateSchema.safeParse({ item: null, canDispatch: false, dispatchMode: "unknown" }).success).toBe(false);
  });
  it.each([
    ["legacy", "order_merchandiser", true, "ready", false, true],
    ["legacy", "order_merchandiser", false, "ready", false, false],
    ["legacy", "production_management", false, "ready", false, false],
    ["legacy", "root_superuser", false, "ready", false, true],
    ["legacy", "order_merchandiser", true, "pending_supplement", false, false],
    ["legacy", "order_merchandiser", true, "ready", true, false],
    ["digital_production_v1", "order_merchandiser", true, "ready", false, false],
    ["digital_production_v1", "root_superuser", false, "ready", false, false],
    ["digital_production_v1", "root_superuser", false, "ready", true, false],
  ] as const)("projects %s mode for %s owner=%s contract=%s dispatched=%s without changing authority", async (generation, role, owns, status, dispatched, allowed) => {
    const reader = actor(role);
    reader.authorizationCapabilities.push("sourcing:contract:record");
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("FROM sourcing_cases source_case")) return { rows: [{
        sourcing_case_id: randomUUID(), created_by: owns ? reader.actorId : randomUUID(),
        contract_status: status, workflow_generation: generation,
      }] };
      if (sql.includes("FROM sourcing_production_orders production")) return { rows: dispatched ? [{
        production_order_id: randomUUID(), status: "in_production", dispatched_at: new Date("2026-10-06T18:05:29Z"),
      }] : [] };
      if (sql.includes("to_regclass")) return { rows: [{ available: false }] };
      throw new Error(`Unexpected state query: ${sql}`);
    });
    const state = SourcingDispatchStateSchema.parse(await new SourcingProductionService({ query } as unknown as Pool).state(reader, randomUUID()));
    expect(state.canDispatch).toBe(allowed);
    expect(state.dispatchMode).toBe(generation === "digital_production_v1" ? "warehouse_actual_dispatch" : "merchandiser");
    expect(Boolean(state.item)).toBe(dispatched);
  });
  it.each(["order_merchandiser", "root_superuser"])("still rejects manual dispatch for digital orders by %s", async role => {
    const query = vi.fn(async (sql: string) => ({ rows: sql.includes("AS generation") ? [{ generation: "digital_production_v1" }] : [] }));
    const release = vi.fn();
    const service = new SourcingProductionService({ connect: async () => ({ query, release }) } as unknown as Pool);
    await expect(service.dispatch(actor(role, "sourcing:contract:record"), randomUUID(), {
      sourcingContractDocumentId: randomUUID(), confirmed: true,
    }, randomUUID())).rejects.toMatchObject({ statusCode: 409, message: "新数字单由仓库完成整款实际发厂后自动接入生产" });
    expect(query.mock.calls.map(([sql]) => sql)).toContain("ROLLBACK");
    expect(query.mock.calls.some(([sql]) => /INSERT|UPDATE/.test(sql))).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("requires explicit confirmation and does not accept prices or finance approval", () => {
    const body = { sourcingContractDocumentId: randomUUID(), confirmed: true };
    expect(DispatchSourcingOrderSchema.safeParse(body).success).toBe(true);
    for (const extra of [{ confirmed: false }, { daxingUnitPrice: "888.1234" }, { financeMatched: true }]) {
      expect(DispatchSourcingOrderSchema.safeParse({ ...body, ...extra }).success).toBe(false);
    }
  });
  it.each(["factory_payables", "ie_reviewer", "warehouse_keeper", "worker", "production_management", "owner_group"])(
    "does not give %s dispatch authority even with a misassigned capability", async (role) => {
      const connect = vi.fn();
      const service = new SourcingProductionService({ connect } as unknown as Pool);
      await expect(service.dispatch(actor(role, "sourcing:contract:record"), randomUUID(), {
        sourcingContractDocumentId: randomUUID(), confirmed: true,
      }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      expect(connect).not.toHaveBeenCalled();
    },
  );
  it.each(["factory_payables", "ie_reviewer", "warehouse_keeper", "worker"])(
    "rejects production queries by %s before database access", async (role) => {
      const query = vi.fn();
      const service = new SourcingProductionService({ query } as unknown as Pool);
      await expect(service.list(actor(role))).rejects.toMatchObject({ statusCode: 403 });
      await expect(service.get(actor(role), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("keeps missing first report distinct from elapsed production time", () => {
    const data = {
      productionOrderId: randomUUID(), sourcingCaseId: randomUUID(), decisionVersion: 1, sourceCaseArchived: false,
      sourcingContractDocumentId: randomUUID(), contractNumber: "DX-WF-20260905-000001", contractVersion: 1,
      supplierId: randomUUID(), supplierName: "长名称加工厂", gender: "男装", styleName: "梭织短裤",
      quantity: 5000, processes: ["车缝", "包装"], deliveryDate: "2026-10-20", firstStyleNo: "DX-A",
      dispatchedBy: randomUUID(), dispatchedAt: new Date().toISOString(), status: "in_production",
      firstReportedOn: null, reportingState: "pending_first_report", timeProgress: null, progressAlert: null,
      lines: [{ position: 1, styleNo: "DX-A", alternateStyleNo: null, color: "黑色", quantity: 5000 }],
    };
    expect(SourcingProductionOrderSchema.parse(data)).toMatchObject({ timeProgress: null, firstReportedOn: null });
    for (const extra of [{ daxingUnitPrice: "888.1234" }, { totalAmount: "1234.00" }, { bankAccount: "6222" }]) {
      expect(SourcingProductionOrderSchema.safeParse({ ...data, ...extra }).success).toBe(false);
    }
  });
  it("prevents finance status from becoming a dispatch prerequisite again", () => {
    const service = readFileSync(new URL("../../apps/api/src/sourcing/sourcing-production-service.ts", import.meta.url), "utf8");
    const migration = readFileSync(new URL("../../apps/api/migrations/0148_sourcing_formal_dispatch.sql", import.meta.url), "utf8");
    expect(service).not.toMatch(/sourcing_finance_reconciliations|pending_finance_reconciliation|contract_fingerprint/);
    expect(migration).not.toMatch(/sourcing_finance_reconciliations|contract_fingerprint/);
  });
});
