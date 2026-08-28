import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board range-scoped style search", () => {
  it("keeps style search inside the selected Shanghai date range", async () => {
    const [service, page] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
    ]);

    expect(service).toContain("receipt.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(service).toContain("receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(service).toContain("batch.style_no ILIKE '%' || $3 || '%'");
    expect(page).toContain('new URLSearchParams({ startDate, endDate })');
    expect(page).not.toContain("disabled={globalSearch}");
    expect(page).not.toContain("全历史收货");
    expect(page).toContain("选中日期内没有匹配的收货记录");
  });
});
