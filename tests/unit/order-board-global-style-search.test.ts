import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board global style search", () => {
  it("keeps date KPIs range-scoped while making non-empty style search all-time", async () => {
    const [service, routes, page, rework, migration] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/api/src/receiving/receiving-routes.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/api/migrations/0115_receiving_style_identity_canonicalization.sql", "utf8"),
    ]);

    expect(service).toContain("const mode = needle ? \"search\" : \"range\"");
    expect(service).toContain("$3::text<>''");
    expect(service).toContain("upper(btrim(batch.style_no)) LIKE '%' || $3 || '%'");
    expect(service).toContain("receipt.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(service).toContain("receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(routes).toContain("status?: string;");
    expect(routes).toContain("request.query.status ?? \"all\"");
    expect(page).toContain('mode: "range" | "search";');
    expect(page).toContain('data?.mode === "search"');
    expect(page).toContain("全时间 · 不受所选日期影响");
    expect(page).toContain("全时间范围内没有匹配的收货记录");
    expect(rework).toContain("styleNo?.trim().toUpperCase()");
    expect(rework).toContain("upper(btrim(batch.style_no))=$1");
    expect(rework).toContain("row.style_no.trim().toUpperCase() !== normalizedStyleNo");
    expect(migration).toContain("upper(btrim(NEW.style_no))<>upper(btrim(batch_style))");
    expect(migration).toContain("hashtext(upper(btrim(batch_style)))");
  });
});
