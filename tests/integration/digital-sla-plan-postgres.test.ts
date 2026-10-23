import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digitalSlaDefaults, resolveDigitalSlaSnapshot } from "../../packages/contracts/src/digital-sla.js";
import { evaluateSlaPlan, type SlaPlan } from "../../packages/domain/src/digital-sla-plan.js";
import { SlaConfigurationRepository, SlaVersionConflict } from "../../apps/api/src/production-platform/sla-configuration-repository.js";
import { SlaPlanRepository } from "../../apps/api/src/production-platform/sla-plan-repository.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";

const url = process.env.TEST_DATABASE_URL, run = url ? describe : describe.skip;
run("SLA P0, formal versions and observed facts", () => {
  const schema = ownedPostgresSchema("sla_plan"), admin = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const actorId = randomUUID(), orderId = randomUUID();
  const at = (h: number) => new Date(Date.parse("2020-01-01T00:00:00Z") + h * 3600000).toISOString();
  const time = (h: number, revision = 1) => ({ now: at(h), scenarioId: "isolated-sla-plan-fixture", revision });
  const p: SlaPlan = { warningPercent: 70, stageBufferMinutes: 0, anchors: { confirmed: { precision: "instant", value: at(0), source: "fixture:confirmation" } }, nodes: [{
    id: "production_sheet", parameterKey: "production_sheet", label: "制单", stage: 3, applicable: "yes", countsProgress: true,
    kind: "duration", minutes: 4320, offsetDays: null, dependsOn: [], anchorKey: "confirmed", targetKey: null,
    includedIn: null, includedPosition: "start",
  }] };
  let snapshotId = "", planId = "";
  const tx = async <T,>(fn: (client: pg.PoolClient) => Promise<T>) => {
    const c = await db.connect();
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (error) { await c.query("ROLLBACK"); throw error; } finally { c.release(); }
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0216_digital_production_order_roots.sql", "0252_digital_sla_configuration_snapshots.sql", "0253_digital_sla_plan_history.sql"])
      await db.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'isolated plan fixture',true)", [actorId]);
    await db.query("INSERT INTO production_order_roots(production_order_id,workflow_generation,created_by) VALUES($1,'digital_production_v1',$2)", [orderId, actorId]);
    const config = await tx(c => new SlaConfigurationRepository(c).initialStandard(actorId));
    expect((await tx(c => new SlaConfigurationRepository(c).initialStandard(actorId))).configurationId).toBe(config.configurationId);
    snapshotId = (await tx(c => new SlaConfigurationRepository(c).appendOrder({ orderId, expectedRevision: 0, configurationId: config.configurationId,
      snapshot: resolveDigitalSlaSnapshot({ version: config.version, values: config.values }), actorId, reason: "fixture enrollment", requestKey: randomUUID() }))).snapshotId;
  });
  afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  it("saves exactly one P0 under concurrency, with retry and immutable real audit time", async () => {
    const input = { orderId, expectedRevision: 0, snapshotId, plan: p, time: time(0), actorId, reason: "first plan", requestKey: randomUUID() };
    const attempts = await Promise.allSettled([tx(c => new SlaPlanRepository(c).appendPlan(input)), tx(c => new SlaPlanRepository(c).appendPlan({ ...input, requestKey: randomUUID() }))]);
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.find(r => r.status === "rejected")).toMatchObject({ reason: expect.any(SlaVersionConflict) });
    const row = (await db.query("SELECT * FROM digital_sla_plans")).rows[0]; planId = row.plan_id;
    expect((await tx(c => new SlaPlanRepository(c).appendPlan({ ...input, requestKey: row.request_key }))).planId).toBe(planId);
    expect(Math.abs(row.recorded_at.getTime() - Date.now())).toBeLessThan(60000);
    expect(row.business_time.now).toBe(at(0));
    await expect(db.query("UPDATE digital_sla_plans SET reason='rewrite'")).rejects.toMatchObject({ code: "55000" });
  });
  it("retains completion lateness when a later plan changes duration", async () => {
    const facts = { startedAt: at(0), completedAt: at(73), standardMinutes: 4320, evidence: "fixture:actual-work" };
    const command = { orderId, nodeId: "production_sheet", planId, expectedRevision: 0, fact: facts, time: time(73, 2), actorId, reason: "real completion", requestKey: randomUUID() };
    await tx(c => new SlaPlanRepository(c).appendFact(command));
    await tx(c => new SlaPlanRepository(c).appendFact(command));
    await expect(tx(c => new SlaPlanRepository(c).appendFact({ ...command, expectedRevision: 1, requestKey: randomUUID(), fact: { ...facts, startedAt: at(2) } }))).rejects.toThrow(/reset/);
    const revised = structuredClone(p); revised.nodes[0]!.minutes = 5760;
    await expect(tx(c => new SlaPlanRepository(c).appendPlan({ orderId, expectedRevision: 1, snapshotId, plan: revised, time: time(74, 3), actorId, reason: "mismatched snapshot", requestKey: randomUUID() }))).rejects.toThrow(/snapshot/);
    const revisedSnapshot = await tx(async c => {
      const repo = new SlaConfigurationRepository(c), values = digitalSlaDefaults(); values.production_sheet = { kind: "duration", minutes: 5760 };
      const config = await repo.publish({ expectedVersion: 1, values, actorId, reason: "confirmed new standard", requestKey: randomUUID() });
      return repo.appendOrder({ orderId, expectedRevision: 1, configurationId: config.configurationId,
        snapshot: resolveDigitalSlaSnapshot({ version: config.version, values }), actorId, reason: "selected order preview confirmed", requestKey: randomUUID() });
    });
    await tx(c => new SlaPlanRepository(c).appendPlan({ orderId, expectedRevision: 1, snapshotId: revisedSnapshot.snapshotId, plan: revised, time: time(74, 3), actorId, reason: "formal future plan revision", requestKey: randomUUID() }));
    const history = await tx(c => new SlaPlanRepository(c).plans(orderId)), savedFacts = await tx(c => new SlaPlanRepository(c).facts(orderId));
    expect(history.map(h => h.revision)).toEqual([1, 2]);
    expect(history[0]!.plan.nodes[0]!.minutes).toBe(4320);
    expect(evaluateSlaPlan(history[1]!.plan, savedFacts, time(80, 3))[0]!.status).toBe("completed_late");
    expect((await db.query("SELECT count(*)::int n FROM digital_sla_node_facts")).rows[0].n).toBe(1);
    await expect(db.query("DELETE FROM digital_sla_node_facts")).rejects.toMatchObject({ code: "55000" });
  });
  it("does not advance or erase history on stale writes, clock rollback, or downstream failure", async () => {
    const next = { orderId, expectedRevision: 2, snapshotId, plan: p, time: time(75, 4), actorId, reason: "next plan", requestKey: randomUUID() };
    await expect(tx(c => new SlaPlanRepository(c).appendPlan({ ...next, expectedRevision: 1 }))).rejects.toBeInstanceOf(SlaVersionConflict);
    await expect(tx(c => new SlaPlanRepository(c).appendPlan({ ...next, time: time(0, 4) }))).rejects.toThrow(/regress/);
    await expect(tx(c => new SlaPlanRepository(c).appendPlan({ ...next, time: { ...time(75, 4), scenarioId: "other-fixture" } }))).rejects.toThrow(/scope/);
    await expect(tx(async c => { await new SlaPlanRepository(c).appendPlan(next); throw new Error("downstream failed"); })).rejects.toThrow("downstream failed");
    expect((await tx(c => new SlaPlanRepository(c).plans(orderId))).length).toBe(2);
    expect((await tx(c => new SlaConfigurationRepository(c).orderSnapshot(orderId, 1)))?.snapshot.parameters.production_sheet!.value).toEqual(digitalSlaDefaults().production_sheet);
  });
});
