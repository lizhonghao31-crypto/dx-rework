import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("HO20544223 tail responsibility repair", () => {
  it("repairs only the verified completed order and fails closed on changed facts", async () => {
    const migration = await readFile(
      "apps/api/migrations/0114_ho20544223_tail_responsibility_repair.sql",
      "utf8",
    );

    expect(migration).toContain("rework_no = 'RW-2026-0826-001'");
    expect(migration).toContain("style_no = 'HO20544223'");
    expect(migration).toContain("target_order.status <> 'completed'");
    expect(migration).toContain("tail_inspection_cost_bearer IS DISTINCT FROM 'processing_factory'");
    expect(migration).toContain("original_responsibility IS DISTINCT FROM 1076.16");
    expect(migration).toContain("added_tail_base IS DISTINCT FROM 390.40");
    expect(migration).toContain("added_responsibility IS DISTINCT FROM 468.48");
    expect(migration).toContain("corrected_responsibility IS DISTINCT FROM 1544.64");
    expect(migration).toContain("recorded deductions or closure");
    expect(migration).toContain("FOR UPDATE OF case_record");
    expect(migration).toContain("refuses a concurrent deduction or closure");
    expect(migration).not.toMatch(/DELETE\s+FROM\s+rework_/i);
    expect(migration).not.toContain("UPDATE rework_orders");
  });

  it("aligns the database completeness rule with the processing-factory bearer", async () => {
    const migration = await readFile(
      "apps/api/migrations/0114_ho20544223_tail_responsibility_repair.sql",
      "utf8",
    );

    expect(migration).toContain("CREATE OR REPLACE FUNCTION validate_responsibility_version");
    expect(migration).toContain("item.execution_kind = 'worker'");
    expect(migration).toContain("item.execution_kind = 'tail_inspection'");
    expect(migration).toContain("target_order.tail_inspection_cost_bearer = 'processing_factory'");
    expect(migration).toContain("CREATE TABLE rework_responsibility_business_corrections");
    expect(migration).toContain("responsibility_business_correction_no_update");
    expect(migration).toContain("authorized_by uuid NOT NULL REFERENCES app_users(id)");
    expect(migration).toContain("ARRAY['root','owner_group']");
    expect(migration).toContain("requires exactly one Root owner to authorize the correction");
  });
});
