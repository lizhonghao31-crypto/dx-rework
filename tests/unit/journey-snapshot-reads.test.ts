import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { reuseJourneySnapshotReads } from "../../apps/api/src/production-platform/journey-snapshot-reads.js";
const result = (rows: unknown[]) => ({ command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows });
describe("Journey read reuse stays inside its read-only snapshot", () => {
  it("reuses identical SQL/parameters while returning independent rows and preserving dates", async () => {
    const query = vi.fn(async () => result([{ name: "TEST", at: new Date("2026-10-15T00:00:00Z"), nested: { value: 1 } }]));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    const first = await db.query("SELECT name,at FROM app_users WHERE id=$1", ["TEST-user"]);
    first.rows[0].nested.value = 9;
    const second = await db.query("SELECT name,at FROM app_users WHERE id=$1", ["TEST-user"]);
    expect(second.rows[0].nested.value).toBe(1); expect(second.rows[0].at).toBeInstanceOf(Date);
    second.rows[0].name = "changed";
    expect((await db.query("SELECT name,at FROM app_users WHERE id=$1", ["TEST-user"])).rows[0].name).toBe("TEST");
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("does not share authorization results across parameters or later snapshots", async () => {
    let allowed = true;
    const query = vi.fn(async () => result([{ allowed }])), client = { query } as unknown as PoolClient;
    const first = reuseJourneySnapshotReads(client);
    await first.query("SELECT role FROM roles WHERE actor=$1", ["A"]);
    await first.query("SELECT role FROM roles WHERE actor=$1", ["B"]);
    allowed = false;
    expect((await reuseJourneySnapshotReads(client).query("SELECT role FROM roles WHERE actor=$1", ["A"])).rows[0].allowed).toBe(false);
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("passes locks, volatile calls and query-config modes through and invalidates session context", async () => {
    let context = "before";
    const query = vi.fn(async (sql: unknown) => { if (sql === "SET ROLE next_role") context = "after"; return result([{ context }]); });
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    await db.query("SELECT current_user"); await db.query("SET ROLE next_role");
    expect((await db.query("SELECT current_user")).rows[0].context).toBe("after");
    for (const sql of ["SELECT 1 FOR SHARE", "SELECT pg_try_advisory_lock(1)", "SELECT clock_timestamp()", "WITH x AS (DELETE FROM t RETURNING *) SELECT * FROM x"]) {
      await db.query(sql); await db.query(sql);
    }
    await db.query({ text: "SELECT 1", rowMode: "array" }); await db.query({ text: "SELECT 1", rowMode: "array" });
    expect(query).toHaveBeenCalledTimes(13);
  });
  it("invalidates earlier reads when a caught statement aborts the transaction", async () => {
    const query = vi.fn().mockResolvedValueOnce(result([{ ok: true }]))
      .mockRejectedValueOnce(new Error("TEST statement failed"))
      .mockRejectedValueOnce(new Error("TEST transaction aborted"));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    await db.query("SELECT previous");
    await expect(db.query("SELECT failure")).rejects.toThrow("TEST statement failed");
    await expect(db.query("SELECT previous")).rejects.toThrow("TEST transaction aborted");
    expect(query).toHaveBeenCalledTimes(3);
  });
  it("does not retain failures, binary/custom rows or oversized results", async () => {
    const query = vi.fn().mockRejectedValueOnce(new Error("TEST transient read"))
      .mockResolvedValueOnce(result([{ ok: true }])).mockResolvedValue(result([{ file: Buffer.from("TEST") }]));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    await expect(db.query("SELECT 1")).rejects.toThrow("TEST transient read");
    expect((await db.query("SELECT 1")).rows[0].ok).toBe(true);
    await db.query("SELECT file"); expect((await db.query("SELECT file")).rows[0].file).toBeInstanceOf(Buffer);
    query.mockResolvedValue(result([{ large: "x".repeat(4 * 1024 * 1024 + 1) }]));
    await db.query("SELECT large"); await db.query("SELECT large");
    expect(query).toHaveBeenCalledTimes(6);
  });
});
