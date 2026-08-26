import { readFile } from "node:fs/promises";

import {
  SOURCING_ACTION_TRANSITIONS,
  transitionSourcingCase,
} from "@dx-rework/domain";
import { describe, expect, it } from "vitest";

describe("sourcing PR02 foundation", () => {
  it("keeps the approved happy path and factory-change path explicit", () => {
    let status = transitionSourcingCase(null, "created");
    status = transitionSourcingCase(status, "decision_recorded");
    status = transitionSourcingCase(status, "contract_recorded");
    status = transitionSourcingCase(status, "factory_change_requested");
    status = transitionSourcingCase(status, "factory_change_approved");
    status = transitionSourcingCase(status, "contract_recorded");
    status = transitionSourcingCase(status, "finance_matched");
    expect(status).toBe("closed");
  });

  it("supports rejected changes and verified finance differences without silent overwrite", () => {
    expect(transitionSourcingCase(
      "pending_factory_change_verification",
      "factory_change_rejected",
    )).toBe("pending_finance_reconciliation");
    expect(transitionSourcingCase(
      "pending_finance_reconciliation",
      "finance_difference",
    )).toBe("pending_exception_verification");
    expect(transitionSourcingCase(
      "pending_exception_verification",
      "exception_reopened_for_reconciliation",
    )).toBe("pending_finance_reconciliation");
    expect(() => transitionSourcingCase("pending_contract", "finance_matched"))
      .toThrowError(/Cannot apply sourcing action/);
  });

  it("keeps one action-specific transition registry aligned with the database states", async () => {
    const sql = await readFile(
      "apps/api/migrations/0097_sourcing_foundation.sql",
      "utf8",
    );
    for (const [action, rule] of Object.entries(SOURCING_ACTION_TRANSITIONS)) {
      expect(sql).toContain(`'${action}'`);
      expect(sql).toContain(`'${rule.to}'`);
      if (rule.from) expect(sql).toContain(`'${rule.from}'`);
    }
  });

  it("models one ERP order per lane and append-only decision, contract, change and finance facts", async () => {
    const sql = await readFile(
      "apps/api/migrations/0097_sourcing_foundation.sql",
      "utf8",
    );
    expect(sql).toContain("UNIQUE(erp_order_id,lane_key)");
    expect(sql).toContain("UNIQUE(sourcing_case_id,decision_version)");
    expect(sql).toContain("CHECK(total_amount=round(unit_price*quantity,2))");
    expect(sql).toContain("sourcing_factory_change_requests");
    expect(sql).toContain("sourcing_factory_change_decisions");
    expect(sql).toContain("sourcing_contract_executions");
    expect(sql).toContain("sourcing_finance_reconciliations");
    expect(sql).toContain("current_sourcing_decisions");
    expect(sql).not.toMatch(/candidate|竞价|多轮报价/i);

    for (const table of [
      "sourcing_cases",
      "sourcing_decisions",
      "sourcing_contracts",
      "sourcing_factory_change_requests",
      "sourcing_factory_change_decisions",
      "sourcing_reconciliations",
      "sourcing_transitions",
    ]) {
      expect(sql).toContain(`CREATE TRIGGER ${table}_no_update`);
      expect(sql).toContain(`CREATE TRIGGER ${table}_no_delete`);
    }
  });

  it("grants write capabilities only to the confirmed operating roles", async () => {
    const sql = await readFile(
      "apps/api/migrations/0097_sourcing_foundation.sql",
      "utf8",
    );
    const grants = [...sql.matchAll(/\('([^']+)','(sourcing:[^']+)'\)/g)]
      .map((match) => [match[1], match[2]]);
    expect(grants).toEqual([
      ["order_merchandiser", "sourcing:inquiry:create"],
      ["production_management", "sourcing:decision:record"],
      ["order_merchandiser", "sourcing:contract:record"],
      ["order_merchandiser", "sourcing:factory_change:request"],
      ["production_management", "sourcing:factory_change:verify"],
      ["factory_payables", "sourcing:finance:reconcile"],
      ["production_management", "sourcing:exception:verify"],
    ]);
  });
});
