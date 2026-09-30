import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("root logical deletion review regressions", () => {
  it("attributes approved wage adjustments to their target wage period", async () => {
    const source = await readFile("apps/api/src/reporting/management-reporting-financial.ts", "utf8");

    expect(source).toContain("approved_adjustments_in_range AS");
    expect(source).toContain("target_period.period_month BETWEEN");
    expect(source).toContain("adjustment.target_period_id");
    expect(source).not.toContain("LEFT JOIN approved_adjustments adjustment");
  });

  it("excludes logically deleted orders from every todo-derived management counter", async () => {
    const [financial, service] = await Promise.all([
      readFile("apps/api/src/reporting/management-reporting-financial.ts", "utf8"),
      readFile("apps/api/src/reporting/management-reporting-service.ts", "utf8"),
    ]);

    for (const source of [financial, service]) {
      expect(source).toContain("route_descriptor->>'reworkOrderId'");
      expect(source).toContain("WHEN 'rework_order'");
      expect(source).toContain("order_record.status IS DISTINCT FROM 'deleted'");
    }
  });

  it("makes deleted orders terminal for attachment bindings", async () => {
    const migration = await readFile("apps/api/migrations/0053_root_rework_order_logical_deletion.sql", "utf8");

    expect(migration).toContain("CREATE OR REPLACE FUNCTION guard_rework_attachment_binding()");
    expect(migration).toContain("order_status NOT IN ('completed','cancelled','deleted')");
  });

  it("does not surface technical system navigation to unauthorized users", async () => {
    const navigation = await readFile("apps/web/src/system-management-navigation.tsx", "utf8");

    expect(navigation).toContain("const visibleTabs = access.technical ? technicalTabs : [];");
  });

  it("keeps the deleted-order external responsibility join unambiguous", async () => {
    const source = await readFile("apps/api/src/rework/fixed-external-responsibility-service.ts", "utf8");

    expect(source).toContain("ORDER BY (batch.status='active') DESC,batch.created_at DESC");
    expect(source).toContain("order_record.status<>'deleted'");
    expect(source).not.toContain("ORDER BY created_at DESC");
  });
});
