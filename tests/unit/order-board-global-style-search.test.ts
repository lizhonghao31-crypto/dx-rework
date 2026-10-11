import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("order board global style search", () => {
  it("keeps date KPIs range-scoped while making non-empty style search all-time", async () => {
    const [service, routes, page, receivingPage, rework, migration] = await Promise.all([
      readFile("apps/api/src/receiving/receiving-service.ts", "utf8"),
      readFile("apps/api/src/receiving/receiving-routes.ts", "utf8"),
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/web/src/receiving-page.tsx", "utf8"),
      readFile("apps/api/src/rework/service.ts", "utf8"),
      readFile("apps/api/migrations/0115_receiving_style_identity_canonicalization.sql", "utf8"),
    ]);

    expect(service).toContain("const mode = needle ? \"search\" : \"range\"");
    expect(service).toContain("$3::text<>''");
    expect(service).toContain("strpos(upper(btrim(batch.style_no)),$3)>0");
    expect(service).toContain("receipt.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(service).toContain("receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')");
    expect(routes).toContain("status?: string;");
    expect(routes).toContain("request.query.status ?? \"all\"");
    expect(page).toContain('mode: "range" | "search";');
    expect(page).toContain('data?.mode === "search"');
    expect(page).toContain("全时间 · 不受所选日期影响");
    expect(page).toContain("全时间范围内没有匹配的收货记录");
    expect(page).toContain('params.set("status", status)');
    expect(page).toContain('<option value="normal">正常</option>');
    expect(page).toContain('<option value="short">少收</option>');
    expect(page).toContain('<option value="extra">多收</option>');
    expect(page).toContain('<option value="multiple">多次收货</option>');
    const filters = await readFile("apps/api/src/receiving/receiving-board-filters.ts", "utf8");
    expect(service).toContain("${boardBaseSql}${RECEIVING_BOARD_FILTERS_SQL}");
    expect(filters).toContain("$4='multiple' AND receipt_count>1");
    expect(page).toContain("event.target.value.toUpperCase()");
    expect(receivingPage).toContain("styleNo.trim().toUpperCase()");
    expect(receivingPage).toContain("setStyleNo(event.target.value)");
    expect(receivingPage).not.toContain("setStyleNo(event.target.value.toUpperCase())");
    expect(rework).toContain("styleNo?.trim().toUpperCase()");
    expect(rework).toContain("upper(btrim(batch.style_no))=$1");
    expect(rework).toContain("WHERE batch.receiving_batch_id=$1");
    expect(rework).toContain("input.styleNo?.trim().toUpperCase() !== current.style_no?.trim().toUpperCase()");
    expect(migration).toContain("upper(btrim(NEW.style_no))<>upper(btrim(batch_style))");
    expect(migration).toContain("hashtext(upper(btrim(batch_style)))");
  });
});
