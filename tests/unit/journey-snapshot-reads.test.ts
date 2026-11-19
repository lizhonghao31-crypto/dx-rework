import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { readJourneyCandidateCohort,reuseJourneySnapshotReads } from "../../apps/api/src/production-platform/journey-snapshot-reads.js";
const result = (rows: unknown[]) => ({ command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows });
describe("Journey read reuse stays inside its read-only snapshot", () => {
  it("keeps earlier reads when a business action literal contains merge or update", async () => {
    const query = vi.fn(async () => result([{ note: "TEST unchanged" }]));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    const sql = "WITH receipt AS (SELECT CASE WHEN action='receiving.batch.merge' THEN 1 ELSE 0 END FROM events) SELECT 'it''s an update',* FROM receipt";
    await db.query("SELECT previous"); await db.query(sql); await db.query(sql); await db.query("SELECT previous");
    expect(query).toHaveBeenCalledTimes(2); expect(query.mock.calls.map(call => call[0])).toEqual(["SELECT previous", sql]);
  });
  it("still passes actual writes, locks and volatile calls outside literals through unchanged", async () => {
    const query = vi.fn(async () => result([{ ok: true }]));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    for (const sql of ["WITH x AS (DELETE FROM t WHERE note='merge' RETURNING *) SELECT * FROM x", "SELECT 'safe' FROM t FOR UPDATE", "SELECT set_config('safe','merge',true)", "SELECT 'merge',random()", "SELECT 'safe' FOR NO KEY UPDATE"]) {
      await db.query("SELECT previous"); await db.query(sql); await db.query(sql); await db.query("SELECT previous");
    }
    expect(query.mock.calls.filter(call => call[0] === "SELECT previous")).toHaveLength(6);
    expect(query).toHaveBeenCalledTimes(16);
  });
  it("does not interpret comments, escape strings, dollar quotes or broken quoting as a reusable read", async () => {
    const query = vi.fn(async () => result([{ ok: true }]));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    for (const sql of ["SELECT 1 --' comment\n FOR UPDATE --'", "SELECT /* ' */ 1 FOR SHARE /* ' */", String.raw`SELECT E'it\'s merge'`, "SELECT $$it's merge$$", "SELECT $body$it's merge$body$", "SELECT 'unterminated", "SELECT ';' AS note"]) {
      await db.query(sql); await db.query(sql);
    }
    expect(query).toHaveBeenCalledTimes(14);
  });
  it("does not let quotes inside identifiers hide a later lock or volatile call", async () => {
    const query = vi.fn(async () => result([{ ok: true }]));
    const db = reuseJourneySnapshotReads({ query } as unknown as PoolClient);
    for (const sql of [`SELECT "first'name", random(), "second'name" FROM t`, `SELECT "a'b",'safe' FROM t FOR UPDATE`, `SELECT "random"()`, `SELECT "broken`]) {
      await db.query(sql); await db.query(sql);
    }
    const safe = `SELECT 'receiving.batch.merge' AS "business' action", 'it''s retained' AS "double""quote"`;
    await db.query(safe); await db.query(safe);
    expect(query).toHaveBeenCalledTimes(9);
  });
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

describe('Cockpit candidate SQL cohorts',()=>{
 it('rebases only real binds and returns authorized rows to their originating candidate in order',async()=>{
  const fieldNames=['__dx_cockpit_candidate','__dx_cockpit_result','note','at','file'];
  const moment=new Date('2026-11-19T17:00:00.000Z');
  const sql="SELECT note,at,file FROM t WHERE id=$1 AND code=$2 AND symbol='$1'";
  const query=vi.fn(async(_text:string,_args:unknown[])=>({
   ...result([{__dx_cockpit_candidate:0,__dx_cockpit_result:'1',note:'first',at:moment,file:Buffer.from('TEST')},
    {__dx_cockpit_candidate:0,__dx_cockpit_result:'2',note:'second'},
    {__dx_cockpit_candidate:1,__dx_cockpit_result:'1',note:'own'}]),
   fields:fieldNames.map(name=>({name}))
  }));
  const db={query} as unknown as PoolClient;
  const rows=await readJourneyCandidateCohort(db,['A','B','A'],async(client,id)=>(await client.query(sql,[id,'TEST'])).rows);
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0]![0]).toContain("WHERE id=$3 AND code=$4 AND symbol='$1'");
  expect(query.mock.calls[0]![1]).toEqual(['A','TEST','B','TEST']);
  expect(rows.map(slot=>slot.map(row=>row.note))).toEqual([['first','second'],['own'],['first','second']]);
  rows[0]![0].file[0]=0;
  expect(rows[2]![0].file).toEqual(Buffer.from('TEST'));expect(rows[2]![0].at).toBeInstanceOf(Date);
 });
 it('fails the cohort before the transaction owner can roll back and does not issue later reads after failure',async()=>{
  const query=vi.fn(async()=>{throw Error('TEST snapshot statement failed');});
  const db={query} as unknown as PoolClient;
  await expect(readJourneyCandidateCohort(db,[1,2],async(client,id)=>{
   if(id===2)try{await client.query('SELECT x FROM t WHERE id=$1',[id]);}catch{await client.query('SELECT retry');}
   else await client.query('SELECT x FROM t WHERE id=$1',[id]);
  })).rejects.toThrow('TEST snapshot statement failed');
  expect(query).toHaveBeenCalledOnce();
 });
});
