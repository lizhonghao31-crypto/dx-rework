import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board global style search", () => {
  it("bypasses date scope only while a style query is active", async () => {
    const [service, page] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
    ]);

    expect(service).toContain("$2::text<>'' OR (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date");
    expect(service).toContain("$2::text<>'' OR (r.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date");
    expect(service).toContain("$2::text<>'' OR (latest.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date");
    expect(page).toContain("disabled={globalSearch}");
    expect(page).toContain('globalSearch ? "匹配订单数" : "今日收货订单数"');
    expect(page).toContain('globalSearch ? "全历史收货" : date');
    expect(page).toContain('debouncedQuery.trim() ? "没有匹配的收货记录" : "当天没有匹配的收货记录"');
  });
});
