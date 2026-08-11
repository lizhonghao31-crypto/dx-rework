import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("responsibility rounding reconciliation", () => {
  it("keeps historical decisions immutable and records only bounded corrections", async () => {
    const migration = await readFile(
      "apps/api/migrations/0047_responsibility_rounding_reconciliation.sql",
      "utf8",
    );

    expect(migration).toContain(
      "CREATE TABLE rework_responsibility_rounding_adjustments",
    );
    expect(migration).toContain("abs(adjustment_amount) <= 0.05");
    expect(migration).toContain(
      "determination.created_at < migration_cutoff.applied_at",
    );
    expect(migration).toContain(
      "BEFORE UPDATE ON rework_responsibility_rounding_adjustments",
    );
    expect(migration).toContain(
      "BEFORE DELETE ON rework_responsibility_rounding_adjustments",
    );
    expect(migration).not.toMatch(
      /UPDATE\s+rework_responsibility_(?:determinations|processes|allocations|amount_lines)/i,
    );
  });

  it("applies the correction consistently to detail and management totals", async () => {
    const [service, orders, financial, report] = await Promise.all([
      readFile(
        "apps/api/src/rework/responsibility-determination-service.ts",
        "utf8",
      ),
      readFile(
        "apps/api/src/reporting/management-reporting-orders.ts",
        "utf8",
      ),
      readFile(
        "apps/api/src/reporting/management-reporting-financial.ts",
        "utf8",
      ),
      readFile(
        "apps/api/src/reporting/management-reporting-report-responsibility.ts",
        "utf8",
      ),
    ]);

    for (const source of [service, orders, financial, report]) {
      expect(source).toContain(
        "rework_responsibility_rounding_adjustments",
      );
    }
    expect(service).toContain("roundingAdjustmentsAvailable");
    expect(orders).toContain("responsibility_adjustments");
    expect(financial).toContain("adjustment.adjustment_amount");
    expect(report).toContain(
      "allocation.rounded_amount +",
    );
  });
});
