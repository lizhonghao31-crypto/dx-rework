import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("sourcing list parity and Root logical deletion", () => {
  it("keeps the rework card information order and Root-only delete affordance", async () => {
    const page = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    const heading = page.indexOf('className="sourcing-order-card__heading"');
    const facts = page.indexOf('<dl className="sourcing-list-facts">', heading);

    expect(heading).toBeGreaterThan(-1);
    expect(page.indexOf("<StatusBadge", heading)).toBeLessThan(facts);
    expect(page).toContain("<dt>订单数量</dt><dd>");
    expect(page).toContain("<dt>IE 单价</dt><dd>");
    expect(page).toContain("<dt>生产单价</dt><dd>");
    expect(page).toContain("<dt>加工厂</dt><dd>");
    expect(page).toContain("<dt>交货日期</dt><dd>");
    expect(page).toContain('canDelete={user?.isRoot === true}');
    expect(page).toContain("confirmInApp(");
    expect(page).toContain('method: "DELETE"');
  });

  it("keeps broad search coverage while hiding deleted cases from every mutation", async () => {
    const service = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    const reads=await readFile("apps/api/src/sourcing/sourcing-case-read.ts","utf8");
    expect(service).toContain("return readSourcingCaseList(this.database,actor");
    expect(reads).toContain("creator_user.display_name ILIKE");
    expect(reads).toContain("decision_row.supplier_name_snapshot ILIKE");
    expect(reads).toContain("decision_row.supplier_code_snapshot ILIKE");
    expect(reads).toContain("case_view.process_description ILIKE");
    expect(service.match(/source_case\.deleted_at IS NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(8);
    expect(service).toContain("async correctBudgetPrice(");
    expect(service).toContain("cancelOpenByDedupePrefix(");
    expect(service).toContain("`sourcing:${sourcingCaseId}:`");
  });

  it("stores deletion metadata without adding a sixth workflow state or removing facts", async () => {
    const migration = await readFile(
      "apps/api/migrations/0122_sourcing_case_logical_deletion.sql",
      "utf8",
    );
    expect(migration).toContain("ADD COLUMN deleted_at timestamptz");
    expect(migration).toContain("deletion_operation_event_id uuid UNIQUE");
    expect(migration).toContain("WHERE deleted_at IS NULL");
    expect(migration).toContain("WHERE sourcing_case.deleted_at IS NULL");
    expect(migration).toContain("sourcing.case.delete");
    expect(migration).not.toContain("DELETE FROM sourcing_");
    expect(migration).not.toContain("'deleted'::text AS status");
  });
});
