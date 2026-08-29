import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { AddIePrecountSchema } from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

const id = "00000000-0000-4000-8000-000000000010";

describe("IE pre-count reference ledger", () => {
  it("accepts one process count with an optional short note", () => {
    expect(AddIePrecountSchema.parse({
      configurationItemId: id,
      quantity: 1080,
      note: "走货前先核",
    })).toEqual({
      configurationItemId: id,
      quantity: 1080,
      note: "走货前先核",
    });
    expect(AddIePrecountSchema.safeParse({
      configurationItemId: id,
      quantity: 0,
    }).success).toBe(false);
    expect(AddIePrecountSchema.safeParse({
      configurationItemId: id,
      quantity: 1.5,
    }).success).toBe(false);
  });

  it("keeps writes IE-only, idempotent and independent from order versions", async () => {
    const [routes, service] = await Promise.all([
      readFile("apps/api/src/rework/routes.ts", "utf8"),
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
    ]);
    expect(routes).toContain('"/rework-orders/:reworkOrderId/ie-precounts"');
    expect(routes).toContain("parse(AddIePrecountSchema, request.body)");
    expect(routes).toContain("await iePrecountActor(request)");
    expect(routes).toContain('"process:review"');
    expect(routes).toContain("只有IE或Root可以记录IE预核数");
    expect(service).toContain('const scope = "rework.ie_precount.record"');
    expect(service).toContain("IdempotencyService");
    expect(service).toContain('["in_progress", "pending_order_review"].includes(row.status)');
    const method = service.slice(
      service.indexOf("async addIePrecount("),
      service.indexOf("async addTailDefectiveQuantity("),
    );
    expect(method).not.toContain("UPDATE rework_orders");
    expect(method).not.toContain("todos");
    expect(method).not.toContain("outbox");
  });

  it("shows the reference record in N04, N05 and N06 without affecting final facts", async () => {
    const page = await readFile("apps/web/src/rework-detail-page.tsx", "utf8");
    expect(page).toContain("IE预核数");
    expect(page).toContain('["work_reporting", "whole_order_review", "final_quantity_ie_review"]');
    expect(page).toContain("用于走货前临时记数");
    expect(page).toContain("不替代N06复核，不计入工资和责任");
    expect(page).toContain("预核记录（最新在上）");
    expect(page).not.toContain("请IE核数");
  });

  it("registers an append-only, audited migration with the exact checksum", async () => {
    const migration = await readFile("apps/api/migrations/0118_ie_precount_ledger.sql");
    const manifest = JSON.parse(await readFile("apps/api/src/platform/migration-manifest.json", "utf8")) as {
      migrations: Array<{ version: string; checksum: string }>;
    };
    const checksum = createHash("sha256").update(migration).digest("hex");
    expect(manifest.migrations).toContainEqual({
      version: "0118_ie_precount_ledger",
      checksum,
    });
    const sql = migration.toString("utf8");
    expect(sql).toContain("rework_ie_precount_entries_no_update");
    expect(sql).toContain("rework_ie_precount_entries_no_delete");
    expect(sql).toContain("rework_ie_precount_entries_no_truncate");
    expect(sql).toContain("event.authorization_capability='process:review'");
    expect(sql).toContain("target.status IN ('in_progress','pending_order_review')");
  });
});
