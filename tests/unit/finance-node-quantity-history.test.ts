import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readFinanceNode } from "../../apps/api/src/reporting/finance-node-reader.js";

// Legacy adjustment records remain readable after their write workflow was retired.
// The full-schema PostgreSQL chain separately executes this N05 query against real tables.
describe("visible N05 finance quantity history", () => {
  it.each(["pending_ie_review", "rejected"])("returns saved %s adjustments on the visible node", async status => {
    const savedRow = ["袖口返修", 1, status, 200, 201, "历史补量申请", "尾部甲", "2026-08-01", "跟单乙", 201, 201, "跟单已确认", "IE 丙", status === "rejected" ? "沿用原数量" : null];
    const query = vi.fn(async (input: string | {text: string}) => {
      const sql = typeof input === "string" ? input : input.text;
      if (sql.includes("FROM rework_orders")) return { rowCount: 1, rows: [[1]] };
      if (sql.includes("FROM rework_process_quantity_adjustments")) return { rowCount: 1, rows: [savedRow] };
      return { rowCount: 0, rows: [] };
    });
    const client = { query, release: vi.fn() };
    const db = { connect: vi.fn(async () => client) } as unknown as Pool;
    const actor = { actorId: "finance", actorRoles: ["finance_director"], authorizationCapability: "rework:finance_nodes:read", requestId: "read-history" };
    const result = await readFinanceNode(db, actor, "order", "whole_order_review");
    const history = result.sections.find(section => section.title === "数量调整记录")!;
    expect(history.rows).toHaveLength(1);
    expect(history.rows[0]![history.columns.indexOf("状态")]).toBe(status);
    expect(history.rows[0]![history.columns.indexOf("申请数量")]).toBe("201");
    expect(history.rows[0]![history.columns.indexOf("原因")]).toBe("历史补量申请");
    expect(history.rows[0]![history.columns.indexOf("确认人")]).toBe("跟单乙");
    expect(history.rows[0]![history.columns.indexOf("审核意见")]).toBe(status === "rejected" ? "沿用原数量" : null);
    expect(query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(query).toHaveBeenCalledWith("COMMIT");
  });
});
