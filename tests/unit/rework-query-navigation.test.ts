import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";

import { fetchFacts } from "../../apps/api/src/reporting/management-reporting-orders.js";
import { decodeCursor, encodeCursor, type FactRow } from "../../apps/api/src/reporting/management-reporting-shared.js";

describe("rework query navigation", () => {
  it("keeps rework lookup in the primary rework board without duplicating a financial-report shortcut", async () => {
    const source = await readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8");

    expect(source).toContain('<Shell active="返工单看板">');
    expect(source).toContain('title="返工单看板"');
    expect(source).not.toContain('action={canViewReports ? "财务报表" : "返回工作台"}');
    expect(source).not.toContain('actionHref={canViewReports ? "/ui/reports" : "/"}');
  });
});


describe("rework query default range and ordering", () => {
  const orderId = "00000000-0000-4000-8000-000000000010";
  const updatedAt = "2026-08-31T12:00:00.000Z";

  it("starts without an implicit date range while preserving explicit URL dates", async () => {
    const source = await readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8");

    expect(source).toContain('const [from,setFrom]=useState(initial.get("from")??"");');
    expect(source).toContain('const [to,setTo]=useState(initial.get("to")??"");');
    expect(source).not.toContain("reportingBusinessMonthStart");
    expect(source).not.toContain("reportingBusinessDate");
  });

  it("requests 15 cards per page and keeps normal previous/next navigation", async () => {
    const source = await readFile("apps/web/src/reporting/rework-query-page.tsx", "utf8");

    expect(source).toContain('limit: "15"');
    expect(source).not.toContain('limit: "40"');
    expect(source).toContain("const [cursorHistory,setCursorHistory]=useState<string[]>([]);");
    expect(source).toContain(">上一页</Button>");
    expect(source).toContain(">下一页</Button>");
    expect(source).toContain("第 {cursorHistory.length + 1} 页");
    expect(source).toContain('setCursorHistory([]);');
  });

  it("encodes the closed-order rank and still accepts cursors issued before this change", () => {
    const cursor = encodeCursor({
      rework_order_id: orderId,
      status: "completed",
      updated_at: new Date(updatedAt),
    } as FactRow);
    expect(decodeCursor(cursor)).toEqual({ closedRank: 1, updatedAt, id: orderId });

    const legacy = Buffer.from(JSON.stringify({ updatedAt, id: orderId }), "utf8").toString("base64url");
    expect(decodeCursor(legacy)).toEqual({ updatedAt, id: orderId });
  });

  it("orders only the rework list with active rows first and keeps legacy cursor paging valid", async () => {
    const listQuery = vi.fn(async () => ({ rows: [] }));
    await fetchFacts({ query: listQuery } as never, {
      limit: 41,
      openFirst: true,
      cursor: { closedRank: 0, updatedAt, id: orderId },
    });
    const [listSql, listValues] = listQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(listSql).toContain(
      "ORDER BY CASE WHEN order_record.status IN ('completed','cancelled') THEN 1 ELSE 0 END ASC,order_record.updated_at DESC,order_record.rework_order_id DESC",
    );
    expect(listValues).toEqual([updatedAt, orderId, 0, 41]);

    const legacyQuery = vi.fn(async () => ({ rows: [] }));
    await fetchFacts({ query: legacyQuery } as never, {
      limit: 41,
      openFirst: true,
      cursor: { updatedAt, id: orderId },
    });
    const [legacySql, legacyValues] = legacyQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(legacySql).toContain("FROM rework_orders cursor_order WHERE cursor_order.rework_order_id=$2::uuid");
    expect(legacyValues).toEqual([updatedAt, orderId, 41]);

    const dashboardQuery = vi.fn(async () => ({ rows: [] }));
    await fetchFacts({ query: dashboardQuery } as never, { limit: 8 });
    const [dashboardSql] = dashboardQuery.mock.calls[0] as unknown as [string, unknown[]];
    expect(dashboardSql).toContain(
      "ORDER BY order_record.updated_at DESC,order_record.rework_order_id DESC",
    );
    expect(dashboardSql).not.toContain("ORDER BY CASE WHEN order_record.status");
  });

  it("enables open-first ordering only for the rework list service call", async () => {
    const source = await readFile("apps/api/src/reporting/management-reporting-service.ts", "utf8");
    expect(source).toContain("openFirst: true,");
    expect(source.match(/openFirst: true,/g)).toHaveLength(1);
  });
});
