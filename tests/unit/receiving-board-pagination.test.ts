import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";

describe("receiving board pagination", () => {
  it("keeps KPI aggregation separate from the 15-row numbered page query", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({
        rows: [{
          order_count: "23",
          received_quantity: "900",
          abnormal_order_count: "4",
          difference_quantity: "30",
          document_quantity: "1000",
        }],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    const connect = vi.fn(async () => ({ query, release }));
    const service = new ReceivingService({ connect } as unknown as Pool);

    const result = await service.board("2026-09-01", "2026-09-01");
    expect(result.kpis).toEqual({
      orderCount: 23,
      receivedQuantity: 900,
      abnormalOrderCount: 4,
      differenceQuantity: 30,
      differenceRate: 3,
    });
    expect(result.rows).toEqual([]);
    expect(result).toMatchObject({ page: 1, pageSize: 15, totalCount: 23, totalPages: 2 });
    expect(query.mock.calls[0]?.[0]).toContain("BEGIN ISOLATION LEVEL REPEATABLE READ");
    expect(query.mock.calls[1]?.[0]).toContain("FROM filtered_totals");
    expect(query.mock.calls[2]?.[0]).toContain("LIMIT 15 OFFSET $5");
    expect(query.mock.calls[2]?.[1]).toEqual(["2026-09-01", "2026-09-01", "", "all", 0]);
    expect(query.mock.calls[2]?.[0]).toContain('HH24:MI:SS.US');
    expect(query.mock.calls[3]?.[0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rejects invalid page numbers before querying PostgreSQL", async () => {
    const connect = vi.fn();
    const service = new ReceivingService({ connect } as unknown as Pool);

    await expect(service.board(
      "2026-09-01",
      "2026-09-01",
      "",
      "all",
      0,
    )).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });
    expect(connect).not.toHaveBeenCalled();
  });
});
