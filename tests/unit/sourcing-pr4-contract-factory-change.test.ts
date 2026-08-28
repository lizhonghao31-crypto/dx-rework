import { readFile } from "node:fs/promises";

import {
  DecideSourcingFactoryChangeSchema,
  RecordSourcingContractSchema,
  RequestSourcingFactoryChangeSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("sourcing PR4 contract and factory change", () => {
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

  it("keeps contract and factory changes audited, versioned and owner-free", async () => {
    const service = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    expect(service).toContain('"sourcing.contract.record"');
    expect(service).toContain('"sourcing.factory_change.request"');
    expect(service).toContain('"sourcing.factory_change.approved"');
    expect(service).toContain('"sourcing.factory_change.rejected"');
    expect(service).toContain('"factory_change"');
    expect(service).toContain("supersedes_decision_id");
    expect(service).toContain('"sourcing_contract_record"');
    expect(service).toContain('"sourcing_factory_change_verify"');
    expect(service).toContain('"sourcing_factory_change_notice"');
    expect(service).toContain("todoProjection?.information");
  });

  it("backfills pre-release actionable todos and keeps the desktop page practical", async () => {
    const [migration, page] = await Promise.all([
      readFile("apps/api/migrations/0107_sourcing_contract_factory_change_todos.sql", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
    ]);
    expect(migration).toContain("pending_contract");
    expect(migration).toContain("pending_factory_change_verification");
    expect(migration).toContain("existing.dedupe_key=dedupe_key_value");
    expect(page).toContain("登记合同");
    expect(page).toContain("发起中途换厂");
    expect(page).toContain("生产管理核实换厂");
    expect(page).toContain("localDateInputValue()");
    expect(page).toContain('item.status === "pending_contract"');
    expect(page).not.toContain("移动端报价选厂");
  });
});
