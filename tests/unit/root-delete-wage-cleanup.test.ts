import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("Root order deletion wage closure", () => {
  it("invalidates only unclosed wage facts and recalculates active period totals", async () => {
    const migration = await read("apps/api/migrations/0075_root_delete_wage_cleanup.sql");

    expect(migration).toContain("ADD COLUMN invalidated_at timestamptz");
    expect(migration).toContain("system_action IS DISTINCT FROM 'root_delete_cleanup'");
    expect(migration).toContain("locked wage history cannot be invalidated");
    expect(migration).toContain("AFTER UPDATE OF status ON rework_orders");
    expect(migration).toContain("WHEN (NEW.status='deleted' AND OLD.status IS DISTINCT FROM 'deleted')");
    expect(migration).toContain("item.invalidated_at IS NULL");
    expect(migration).toContain("orders.status='deleted'");
    expect(migration).toContain("period.status<>'locked'");
  });

  it("hides empty unclosed periods and invalidated detail rows", async () => {
    const source = await read("apps/api/src/wages/wage-service.ts");

    expect(source).toContain("WHERE status='locked' OR source_item_count>0");
    expect(source).toContain("WHERE period_id=$1 AND (status='locked' OR source_item_count>0)");
    expect(source).toContain("AND item.invalidated_at IS NULL");
    expect(source).toContain("WHERE period_id=$1 AND invalidated_at IS NULL");
  });

  it("excludes invalidated rows from unlocked Excel while preserving locked snapshots", async () => {
    const source = await read("apps/api/src/wages/wage-export-service.ts");

    expect(source).toContain("WHERE period_id=$1 AND (status='locked' OR source_item_count>0)");
    expect(source).toContain("AND item.invalidated_at IS NULL");
    expect(source).toContain("FROM rework_wage_month_closures closure");
    expect(source).toContain("lines.final_amount::text wage_amount");
  });
});
