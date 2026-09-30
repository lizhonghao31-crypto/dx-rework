import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("tail inspection foundation", () => {
  it("keeps the tail inspector limited to its dedicated reporting capability", async () => {
    const [migration, display] = await Promise.all([
      readFile("apps/api/migrations/0066_tail_inspection_foundation.sql", "utf8"),
      readFile("packages/contracts/src/business-display.ts", "utf8"),
    ]);

    expect(migration).toContain("('tail_inspector','尾查'");
    expect(migration).toContain("('tail_inspector','tail_inspection:report')");
    expect(migration).not.toContain("('tail_inspector','process:configure')");
    expect(migration).not.toContain("('tail_inspector','submission:audit')");
    expect(display).toContain('tail_inspector: "整查"');
    expect(display).toContain('"tail_inspection:report": "整查报数"');
  });

  it("stores independent, audited assignments and per-process physical counts", async () => {
    const [migration, rootReportingMigration] = await Promise.all([
      readFile("apps/api/migrations/0066_tail_inspection_foundation.sql", "utf8"),
      readFile("apps/api/migrations/0070_root_tail_inspection_reporting.sql", "utf8"),
    ]);

    expect(migration).toContain("rework_tail_inspection_assignments");
    expect(migration).toContain("box_scope text CHECK");
    expect(migration).toContain("rework_tail_inspection_reports");
    expect(migration).toContain("returned_quantity numeric(12,0)");
    expect(migration).toContain("rework_tail_inspection_report_items");
    expect(migration).toContain("inspected_quantity>report_returned_quantity");
    expect(migration).toContain("rework.tail_inspection.revoke");
    expect(migration).not.toContain("target.status='pending_ie_review'");
    expect(rootReportingMigration).toContain("assignment.tail_inspector_user_id=NEW.submitted_by");
    expect(rootReportingMigration).toContain("event.actor_roles @> ARRAY['root_superuser']::text[]");
    expect(rootReportingMigration).toContain("access_is_root_actor(event.actor_id)");
  });
});
