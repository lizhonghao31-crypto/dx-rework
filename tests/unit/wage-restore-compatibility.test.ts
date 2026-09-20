import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("retired wage adjustment restore compatibility", () => {
  it("removes the cross-table Root CHECK while preserving retired write guards", async () => {
    const retirement = await readFile(
      new URL("../../apps/api/migrations/0074_wage_review_adjustment_retirement.sql", import.meta.url),
      "utf8",
    );
    const compatibility = await readFile(
      new URL("../../apps/api/migrations/0203_wage_adjustment_restore_compatibility.sql", import.meta.url),
      "utf8",
    );

    expect(retirement).toContain("wage adjustment workflow is retired");
    expect(retirement).toContain("CREATE OR REPLACE FUNCTION guard_wage_adjustment_insert()");
    expect(retirement).toContain("CREATE OR REPLACE FUNCTION guard_wage_adjustment_update()");

    expect(compatibility).toContain(
      "DROP CONSTRAINT IF EXISTS rework_wage_adjustments_decider_separation_check",
    );
    expect(compatibility).toContain("wage adjustment retirement guards are not active");
    expect(compatibility).toContain("wage_adjustments_guard_insert");
    expect(compatibility).toContain("wage_adjustments_guard_update");
    expect(compatibility).toContain("pg_get_constraintdef");
    expect(compatibility).toContain("access_is_root_actor");
    expect(compatibility).not.toContain("DISABLE TRIGGER");
    expect(compatibility).not.toContain("DROP TABLE");
  });
});
