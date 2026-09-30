import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { normalizeReceivingBackfillDate } from "../../apps/api/src/receiving/receiving-service.js";

describe("Root UAT PR-05 receiving backfill", () => {
  const now = new Date("2026-08-25T04:00:00.000Z");

  it("accepts only yesterday and the day before in the Shanghai business timezone", () => {
    expect(normalizeReceivingBackfillDate(undefined, now)).toBeNull();
    expect(normalizeReceivingBackfillDate("2026-08-24", now)).toBe("2026-08-24");
    expect(normalizeReceivingBackfillDate("2026-08-23", now)).toBe("2026-08-23");
    expect(() => normalizeReceivingBackfillDate("2026-08-25", now)).toThrow("今天请使用普通收货");
    expect(() => normalizeReceivingBackfillDate("2026-08-22", now)).toThrow("仅支持昨天和前天");
    expect(() => normalizeReceivingBackfillDate("2026-02-30", now)).toThrow("补录日期无效");
  });

  it("keeps the existing plus entry and adds a bounded backfill path without changing the order board", async () => {
    const [page, route, service, board] = await Promise.all([
      readFile("apps/web/src/receiving-page.tsx", "utf8"),
      readFile("apps/api/src/receiving/receiving-routes.ts", "utf8"),
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
    ]);

    expect(page).toContain('<span aria-hidden="true">＋</span>');
    expect(page).toContain('className="receiving-backfill-start"');
    expect(page).toContain("min={businessDateDaysAgo(2)}");
    expect(page).toContain("max={businessDateDaysAgo(1)}");
    expect(page).toContain("...(backfill ? { receivedDate } : {})");
    expect(route).toContain('typeof body.receivedDate !== "string"');
    expect(service).toContain("if (!receivedDate && current && !current.closed)");
    expect(service).toContain("backfill_event.after_state->>'backfilled'='true'");
    expect(service).toContain("received_by,operation_event_id,request_id,received_at");
    expect(service).toContain("backfilled: true");
    expect(board).not.toContain("receiving-backfill-start");
  });
});
