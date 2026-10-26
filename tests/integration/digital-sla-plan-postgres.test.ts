import { applySlaPolicyFixture } from "../helpers/sla-policy-fixture.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digitalSlaDefaults, resolveDigitalSlaSnapshot } from "../../packages/contracts/src/digital-sla.js";
import { evaluateSlaPlan, type SlaPlan } from "../../packages/domain/src/digital-sla-plan.js";
import { SlaConfigurationRepository, SlaVersionConflict } from "../../apps/api/src/production-platform/sla-configuration-repository.js";
import { SlaPlanRepository } from "../../apps/api/src/production-platform/sla-plan-repository.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { applyOrderCreationEvidence, orderCreationSlaEvidence } from "../../apps/api/src/production-platform/sla-order-evidence.js";

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
    await applySlaPolicyFixture(db);
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
    // Compatibility fixture written by the previous implementation. The current repository has no fact writer.
    const completedDeadline = evaluateSlaPlan(p, { production_sheet: facts }, time(73, 2))[0]!.deadline;
    await db.query(`INSERT INTO digital_sla_node_facts(fact_id,production_order_id,node_id,revision,plan_id,fact_json,business_time,created_by,reason,request_key)
      VALUES($1,$2,'production_sheet',1,$3,$4,$5,$6,'legacy completion fixture',$7)`,
      [randomUUID(), orderId, planId, JSON.stringify({ ...facts, completedDeadline }), JSON.stringify(time(73, 2)), actorId, randomUUID()]);
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
  it("reads creation actuals from the scoped business event without another actual ledger", async () => {
    const eventId = randomUUID();
    await db.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,after_state)
      VALUES($1,'fixture',$2,'digital_order_created','digital_order',$3,$4)`, [eventId, actorId, orderId, JSON.stringify({ slaBusinessTime: time(0) })]);
    await tx(async c => {
      const original = structuredClone((await new SlaPlanRepository(c).plans(orderId))[0]!);
      original.plan.anchors.customer_order_confirmed = { precision: "instant", value: at(0), source: `audit_events:${eventId}` };
      const facts = await orderCreationSlaEvidence(c, orderId, original);
      expect(facts.production_sheet).toEqual({ startedAt: at(0), standardMinutes: 4320, evidence: `audit_events:${eventId}` });
      expect(facts.customer_confirmation?.completedAt).toBe(at(0));
      const legacy = await new SlaPlanRepository(c).facts(orderId);
      const resolved = applyOrderCreationEvidence(legacy, facts);
      expect(resolved.production_sheet?.completedAt).toBe(at(73));
      expect(resolved.production_sheet?.completedDeadline).toEqual(legacy.production_sheet?.completedDeadline);
      expect(resolved.production_sheet?.startedAt).toBe(at(0));
      expect(applyOrderCreationEvidence(legacy, {})).toEqual(legacy);
      expect(await orderCreationSlaEvidence(c, randomUUID(), original)).toEqual({});
      expect((await c.query("SELECT count(*)::int n FROM digital_sla_node_facts")).rows[0].n).toBe(1); // only the old compatibility fixture
      original.time.scenarioId = "other-test-scope";
      await expect(orderCreationSlaEvidence(c, orderId, original)).rejects.toThrow(/scope/);
    });
  });
  it('retains completed node targets only by an exact prior node and same-order snapshot reference',async()=>{
    await tx(async c=>{
      const plans=new SlaPlanRepository(c),before=(await plans.plans(orderId)).at(-1)!,repo=new SlaConfigurationRepository(c),current=(await repo.current())!,values=structuredClone(current.values);
      values.production_sheet={kind:'duration',minutes:6000};const published=await repo.publish({expectedVersion:current.version,values,actorId,reason:'TEST future standard',requestKey:randomUUID()}),latest=(await repo.orderSnapshot(orderId))!;
      const snapshot=await repo.appendOrder({orderId,expectedRevision:latest.revision,configurationId:published.configurationId,snapshot:resolveDigitalSlaSnapshot({version:published.version,values}),actorId,reason:'TEST selected future windows',requestKey:randomUUID()});
      const plan=structuredClone(before.plan);plan.retainedNodeSnapshots={production_sheet:before.snapshotId};
      const input={orderId,expectedRevision:before.revision,snapshotId:snapshot.snapshotId,plan,time:time(81,5),actorId,reason:'TEST preserve completed target',requestKey:randomUUID()};
      const saved=await plans.appendPlan(input);expect(saved.plan.nodes).toEqual(before.plan.nodes);
      const forged=structuredClone(plan);forged.nodes[0]!.minutes=60;
      await expect(plans.appendPlan({...input,expectedRevision:saved.revision,plan:forged,requestKey:randomUUID()})).rejects.toThrow(/Retained/);
      const foreign=structuredClone(plan);foreign.retainedNodeSnapshots!.production_sheet=randomUUID();
      await expect(plans.appendPlan({...input,expectedRevision:saved.revision,plan:foreign,requestKey:randomUUID()})).rejects.toThrow(/Retained/);
    });
  });

});
