import { readFile } from "node:fs/promises";

import {
  DecideSourcingFactoryChangeSchema,
  RecordSourcingContractSchema,
  RequestSourcingFactoryChangeSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("sourcing five-stage factory change compatibility", () => {
  it("validates the three desktop actions at the contract boundary", () => {
    expect(RecordSourcingContractSchema.parse({
      contractReference: "HT-2026-001",
      signedOn: "2026-08-28",
    })).toMatchObject({ contractReference: "HT-2026-001" });
    expect(RequestSourcingFactoryChangeSchema.safeParse({
      supplierId: "00000000-0000-4000-8000-000000000001",
      unitPrice: "10.5000",
      changeReason: "",
    }).success).toBe(false);
    expect(DecideSourcingFactoryChangeSchema.safeParse({
      decision: "approved",
      verificationReason: "已核实产能与交期",
    }).success).toBe(true);
  });

  it("keeps historical contracts and factory changes audited while routing new work to finance", async () => {
    const service = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    expect(service).toContain('"sourcing.contract.record"');
    expect(service).toContain('"sourcing.factory_change.request"');
    expect(service).toContain('"sourcing.factory_change.approved"');
    expect(service).toContain('"sourcing.factory_change.rejected"');
    expect(service).toContain('"factory_change"');
    expect(service).toContain("supersedes_decision_id");
    expect(service).not.toContain('category: "sourcing_contract_record"');
    expect(service).toContain('category: "sourcing_finance_reconcile"');
    expect(service).toContain('"sourcing_factory_change_verify"');
    expect(service).toContain('"sourcing_factory_change_notice"');
    expect(service).toContain("todoProjection?.information");
  });

  it("migrates old contract-stage work and keeps the five-stage desktop page practical", async () => {
    const [migration, page] = await Promise.all([
      readFile("apps/api/migrations/0121_sourcing_remove_contract_stage.sql", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
    ]);
    expect(migration).toContain("contract_stage_retired");
    expect(migration).toContain("'pending_contract','pending_finance_reconciliation'");
    expect(migration).toContain("sourcing_finance_reconcile");
    expect(page).not.toContain('{ key: "contract"');
    expect(page).not.toContain(">登记合同</button>");
    expect(page).toContain("发起中途换厂");
    expect(page).toContain("生产管理核实换厂");
    expect(page).toContain('{ key: "finance", number: "05"');
    expect(page).not.toContain("移动端报价选厂");
  });
});
