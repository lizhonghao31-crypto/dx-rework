import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digitalSlaDefaults, resolveDigitalSlaSnapshot } from "../../packages/contracts/src/digital-sla.js";
import { SlaConfigurationRepository, SlaIdempotencyConflict, SlaVersionConflict } from "../../apps/api/src/production-platform/sla-configuration-repository.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";

const url = process.env.TEST_DATABASE_URL;
const run = url ? describe : describe.skip;
run("SLA immutable standards and order snapshots", () => {
  const schema = ownedPostgresSchema("sla_config");
  const admin = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const actorId = randomUUID(), orderId = randomUUID();
  async function transaction<T>(fn: (repo: SlaConfigurationRepository, client: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await db.connect();
    try { await c.query("BEGIN"); const result = await fn(new SlaConfigurationRepository(c), c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK"); throw error; }
    finally { c.release(); }
  }
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0216_digital_production_order_roots.sql", "0252_digital_sla_configuration_snapshots.sql"]) {
      await db.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    }
    await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'SLA fixture',true)", [actorId]);
    await db.query("INSERT INTO production_order_roots(production_order_id,workflow_generation,created_by) VALUES($1,'digital_production_v1',$2)", [orderId, actorId]);
  });
  afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  it("serializes concurrent publications, rejects stale version, and returns the exact retry", async () => {
    const input = { expectedVersion: 0, values: digitalSlaDefaults(), actorId, reason: "confirmed initial standard", requestKey: randomUUID() };
    const attempts = await Promise.allSettled([
      transaction(repo => repo.publish(input)),
      transaction(repo => repo.publish({ ...input, requestKey: randomUUID() })),
    ]);
    expect(attempts.filter(row => row.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find(row => row.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(SlaVersionConflict);
    const row = (await db.query("SELECT * FROM digital_sla_configurations")).rows[0];
    const retry = await transaction(repo => repo.publish({ ...input, requestKey: row.request_key }));
    expect(retry.configurationId).toBe(row.configuration_id);
    await expect(transaction(repo => repo.publish({ ...input, requestKey: row.request_key, reason: "different command" }))).rejects.toBeInstanceOf(SlaIdempotencyConflict);
    await expect(db.query("UPDATE digital_sla_configurations SET reason='rewritten'")).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("DELETE FROM digital_sla_configurations")).rejects.toMatchObject({ code: "55000" });
  });
  it("keeps original order values when new standards publish, with exact retry and safe rollback", async () => {
    const config = (await db.query("SELECT * FROM digital_sla_configurations WHERE version=1")).rows[0];
    const snapshot = resolveDigitalSlaSnapshot({ version: 1, values: config.values_json });
    const input = { orderId, expectedRevision: 0, configurationId: config.configuration_id as string, snapshot, actorId, reason: "order created", requestKey: randomUUID() };
    const first = await transaction(repo => repo.appendOrder(input));
    expect((await transaction(repo => repo.appendOrder(input))).snapshotId).toBe(first.snapshotId);
    await expect(transaction(repo => repo.appendOrder({ ...input, requestKey: randomUUID() }))).rejects.toBeInstanceOf(SlaVersionConflict);
    const values = digitalSlaDefaults(); values.production_sheet = { kind: "duration", minutes: 5760 };
    await transaction(repo => repo.publish({ expectedVersion: 1, values, actorId, reason: "new orders only", requestKey: randomUUID() }));
    const saved = (await db.query("SELECT * FROM digital_sla_order_snapshots WHERE snapshot_id=$1", [first.snapshotId])).rows[0];
    expect(saved.parameters_json.production_sheet.value.minutes).toBe(4320);
    expect((await transaction(repo => repo.current()))?.version).toBe(2);
    expect((await transaction(repo => repo.orderSnapshot(orderId, 1)))?.snapshot.parameters.production_sheet?.value).toEqual({ kind: "duration", minutes: 4320 });
    expect(await transaction(repo => repo.orderSnapshot(orderId, 2))).toBeNull();
    await expect(db.query("UPDATE digital_sla_order_snapshots SET parameters_json='{}'")).rejects.toMatchObject({ code: "55000" });
    await expect(db.query("DELETE FROM digital_sla_order_snapshots")).rejects.toMatchObject({ code: "55000" });
    const wrongSource = resolveDigitalSlaSnapshot({ version: 2, values });
    await expect(transaction(repo => repo.appendOrder({ ...input, expectedRevision: 1, snapshot: wrongSource, requestKey: randomUUID() }))).rejects.toThrow(/global source/);
    await expect(transaction(async repo => { await repo.appendOrder({ ...input, expectedRevision: 1, requestKey: randomUUID() }); throw new Error("downstream failed"); })).rejects.toThrow("downstream failed");
    expect((await db.query("SELECT count(*) AS n FROM digital_sla_order_snapshots")).rows[0].n).toBe("1");
  });
  it("rejects unknown orders and malformed values without persisting rows", async () => {
    const config = (await db.query("SELECT * FROM digital_sla_configurations WHERE version=2")).rows[0];
    await expect(transaction(repo => repo.appendOrder({ orderId: randomUUID(), expectedRevision: 0, configurationId: config.configuration_id, snapshot: resolveDigitalSlaSnapshot({ version: 2, values: config.values_json }), actorId, reason: "not an order", requestKey: randomUUID() }))).rejects.toThrow(/not found/);
    await expect(transaction(repo => repo.publish({ expectedVersion: 2, values: { budget: { kind: "duration", minutes: 30 } }, actorId, reason: "invalid", requestKey: randomUUID() }))).rejects.toThrow();
    expect((await db.query("SELECT count(*) AS n FROM digital_sla_configurations")).rows[0].n).toBe("2");
  });
});
