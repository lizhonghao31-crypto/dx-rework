import pg, { type Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readFinanceNode } from "../../apps/api/src/reporting/finance-node-reader.js";

const orderId = "11111111-1111-4111-8111-111111111111";
const actor = {
  actorId: "22222222-2222-4222-8222-222222222222",
  actorRoles: ["finance_director"],
  authorizationCapability: "rework:finance_nodes:read",
  requestId: "finance-natural-date-regression",
};
const parseDate = pg.types.getTypeParser(1082, "text");
const parseText = pg.types.getTypeParser(25, "text");
const markedAt = new Date("2026-10-09T04:56:23.456Z");
const createdAt = new Date("2026-10-09T07:08:09.987Z");

describe("finance node natural dates and genuine timestamps", () => {
  it.each(["settlement_ledger", "settlement_followup"] as const)(
    "keeps date-only values and timestamp precision at %s",
    async node => {
      const query = vi.fn(async (input: string | { text: string; values?: unknown[] }) => {
        const sql = typeof input === "string" ? input : input.text;
        if (sql.includes("SELECT 1 FROM rework_orders")) return { rowCount: 1, rows: [[1]] };
        if (sql.includes("FROM filtered WHERE rework_order_id=$8")) {
          expect(sql).toContain("wage_amount,completed_date::text,");
          // PostgreSQL DATE uses the real pg Date parser; ::text bypasses that parser.
          const completedDate = sql.includes("completed_date::text") ? parseText("2026-10-09") : parseDate("2026-10-09");
          return { rowCount: 2, rows: [
            ["工人甲", "internal", "袖口返修", "10", "1.25", "12.50", completedDate, "已结算", "财务乙", markedAt],
            ["工人丙", "temporary", "衣领返修", "1", "2.50", "2.50", null, "未结算", null, null],
          ] };
        }
        if (sql.includes("JOIN rework_external_deduction_entries entry")) {
          expect(sql).toContain("entry.deducted_on::text");
          const deductedOn = sql.includes("entry.deducted_on::text") ? parseText("2026-10-08") : parseDate("2026-10-08");
          return { rowCount: 2, rows: [
            ["供应商甲", "deduction", "12.50", deductedOn, "TEST-REFERENCE", "财务乙", createdAt],
            ["供应商甲", "reversal", "-2.50", null, null, "财务乙", createdAt],
          ] };
        }
        return { rowCount: 0, rows: [] };
      });
      const client = { query, release: vi.fn() };
      const db = { connect: vi.fn(async () => client) } as unknown as Pool;
      expect(parseDate("2026-10-09")).toBeInstanceOf(Date);
      const result = await readFinanceNode(db, actor, orderId, node);
      const wages = result.sections.find(section => section.title === "工资明细")!;
      const deductions = result.sections.find(section => section.title === "实际扣款明细")!;
      expect(wages.rows[0]).toEqual([
        "工人甲", "internal", "袖口返修", "10", "1.25", "12.50", "2026-10-09", "已结算", "财务乙", markedAt.toISOString(),
      ]);
      expect(wages.rows[1]![wages.columns.indexOf("完工日期")]).toBeNull();
      expect(wages.rows[1]![wages.columns.indexOf("标记时间")]).toBeNull();
      expect(deductions.rows[0]).toEqual([
        "供应商甲", "deduction", "12.50", "2026-10-08", "TEST-REFERENCE", "财务乙", createdAt.toISOString(),
      ]);
      expect(deductions.rows[1]![deductions.columns.indexOf("扣款日期")]).toBeNull();
      expect(deductions.rows[1]![deductions.columns.indexOf("时间")]).toBe(createdAt.toISOString());
      expect(query).toHaveBeenCalledWith("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      expect(query).toHaveBeenCalledWith("SELECT access_authorized_actor_roles($1,$2)", [actor.actorId, "rework:finance_nodes:read"]);
      expect(query).toHaveBeenCalledWith("COMMIT");
      expect(client.release).toHaveBeenCalledOnce();
    },
  );

  it("does not turn a missing finance-read capability into access", async () => {
    const connect = vi.fn();
    await expect(readFinanceNode(
      { connect } as unknown as Pool,
      { ...actor, authorizationCapability: "work:report" },
      orderId,
      "settlement_ledger",
    )).rejects.toMatchObject({ statusCode: 403 });
    expect(connect).not.toHaveBeenCalled();
  });
});
