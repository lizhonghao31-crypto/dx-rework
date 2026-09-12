import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { canAccessFinance } from "../../apps/web/src/finance-access.js";
import { canAccessFinanceWages, requireFinanceWageAccess } from "../../apps/api/src/wages/wage-access.js";
import { ManagementReportingService } from "../../apps/api/src/reporting/management-reporting-service.js";
import { WageService } from "../../apps/api/src/wages/wage-service.js";

const actor = (roles: string[]) => ({ actorId: "test", actorRoles: roles, requestId: "test", authorizationCapability: "wage:view",
  authorizationCapabilities: ["wage:view", "wage:export", "wage:settlement_mark", "report:view"] });

describe("finance wage shared scope", () => {
  it.each(["owner_group", "production_management", "finance_director", "wage_month_close_accountant", "finance_read"])("shows the finance entry for %s", role => {
    expect(canAccessFinance({ id: "test", displayName: "同名", businessRoles: [role], capabilities: ["wage:view"] })).toBe(true);
  });
  it.each(["worker", "tail_supervisor", "sample_designer", "pattern_room_supervisor", "order_merchandiser", "warehouse_receiver"])("hides finance and rejects all service paths for %s", async role => {
    const a = actor([role]);
    expect(canAccessFinance({ id: "test", displayName: "财务总监", businessRoles: [role], capabilities: ["wage:view"] })).toBe(false);
    const query = vi.fn();
    const db = { query } as unknown as Pool;
    const report = new ManagementReportingService(db);
    const wage = new WageService(db);
    for (const action of [() => wage.list(a), () => wage.get(a, "period"), () => wage.item(a, "item"),
      () => report.report(a, "wages", { limit: 100 }), () => report.exportData(a, "wages", { limit: 100 }),
      () => report.previewWageSettlement(a, { limit: 100 }), () => report.markWageSettlement(a, { limit: 100 }, ["item"])]) {
      await expect(action()).rejects.toMatchObject({ statusCode: 403 });
    }
    expect(query).not.toHaveBeenCalled();
  });
  it("requires marker role plus capability, and handles multi-role and Root", () => {
    expect(canAccessFinanceWages(actor(["owner_group"]), "wage:settlement_mark")).toBe(false);
    expect(canAccessFinanceWages(actor(["production_management"]), "wage:settlement_mark")).toBe(false);
    expect(canAccessFinanceWages(actor(["owner_group", "finance_read"]), "wage:settlement_mark")).toBe(true);
    expect(canAccessFinanceWages({ ...actor(["finance_read"]), authorizationCapabilities: ["wage:view"] }, "wage:settlement_mark")).toBe(false);
    expect(canAccessFinanceWages({ ...actor(["root_superuser"]), authorizationCapabilities: [] }, "wage:settlement_mark")).toBe(true);
  });
  it("propagates a persisted permission revocation before reading data", async () => {
    const denied = new Error("database authority revoked");
    const query = vi.fn().mockRejectedValue(denied);
    await expect(requireFinanceWageAccess({ query } as unknown as Pool, actor(["finance_read"]), "wage:view")).rejects.toBe(denied);
    expect(query).toHaveBeenCalledWith("SELECT finance_authorized_wage_roles($1,$2)", ["test", "wage:view"]);
  });
});
