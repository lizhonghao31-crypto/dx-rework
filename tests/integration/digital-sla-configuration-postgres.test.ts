import { applySlaPolicyFixture } from "../helpers/sla-policy-fixture.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { digitalSlaDefaults, resolveDigitalSlaSnapshot } from "../../packages/contracts/src/digital-sla.js";
import { SlaConfigurationRepository, SlaIdempotencyConflict, SlaVersionConflict } from "../../apps/api/src/production-platform/sla-configuration-repository.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { SlaConfigurationService } from "../../apps/api/src/production-platform/sla-configuration-service.js";
import { readSlaPolicyValues } from "../../apps/api/src/production-platform/sla-policy-values.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

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
    await applySlaPolicyFixture(db);
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
    const snapshot = resolveDigitalSlaSnapshot({ version: 1, values: (await transaction(repo => repo.current()))!.values });
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
    const currentValues = (await transaction(repo => repo.current()))!.values;
    await expect(transaction(repo => repo.appendOrder({ orderId: randomUUID(), expectedRevision: 0, configurationId: config.configuration_id, snapshot: resolveDigitalSlaSnapshot({ version: 2, values: currentValues }), actorId, reason: "not an order", requestKey: randomUUID() }))).rejects.toThrow(/not found/);
    await expect(transaction(repo => repo.publish({ expectedVersion: 2, values: { budget: { kind: "duration", minutes: 30 } }, actorId, reason: "invalid", requestKey: randomUUID() }))).rejects.toThrow();
    expect((await db.query("SELECT count(*) AS n FROM digital_sla_configurations")).rows[0].n).toBe("2");
  });
  it("stores duration versions only in the original policies and retains exact old references", async () => {
    const records = (await db.query("SELECT * FROM digital_sla_configurations ORDER BY version")).rows;
    expect(records[0].values_json.production_sheet).toEqual({ kind: "duration", minutes: 4320 }); // old reader shape
    expect(records[0].policy_refs_json.storage).toBe("policy_refs_v1");
    expect(records[0].policy_refs_json.parameters.production_sheet).toBeUndefined();
    expect(records[0].policy_refs_json.policies.production_sheet).toMatchObject({ nodeKey: "production_sheet" });
    await transaction(async (_, c) => {
      expect((await readSlaPolicyValues(c, records[0].policy_refs_json)).production_sheet).toEqual({ kind: "duration", minutes: 4320 });
      expect((await readSlaPolicyValues(c, records[1].policy_refs_json)).production_sheet).toEqual({ kind: "duration", minutes: 5760 });
      // Compatibility with immutable publications created by the previous implementation.
      expect(await readSlaPolicyValues(c, digitalSlaDefaults())).toEqual(digitalSlaDefaults());
    });
    await expect(db.query("UPDATE digital_production_deadline_policies SET sla_seconds=1 WHERE node_key='production_sheet'")).rejects.toMatchObject({ code: "55000" });
    await expect(db.query(`INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
      SELECT node_key,max(version)+1,'old application write',100,0.7 FROM digital_production_deadline_policies WHERE node_key='production_sheet' GROUP BY node_key`)).rejects.toMatchObject({ code: "55000" });
    // Domain migrations can still install their original seed after a foundation was used.
    await db.query("INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio) VALUES('development_external_pattern',1,'fixture',172800,0.7)");
    const before = (await db.query("SELECT count(*) n FROM digital_production_deadline_policies")).rows[0].n;
    await expect(transaction(async repo => {
      const values = (await repo.current())!.values; values.production_sheet = { kind: "duration", minutes: 6000 };
      await repo.publish({ expectedVersion: 2, values, actorId, reason: "rollback", requestKey: randomUUID() });
      throw new Error("rollback publication");
    })).rejects.toThrow("rollback publication");
    expect((await db.query("SELECT count(*) n FROM digital_production_deadline_policies")).rows[0].n).toBe(before);
  });
  it("allows all three setting roles and denies other roles before publishing", async () => {
    const service = new SlaConfigurationService();
    const actor = (roles: string[]): TrustedActorContext => ({ actorId, actorRoles: roles, requestId: "isolated-sla-publication",
      authorizationCapability: "pattern_room:orders:create", authorizationCapabilities: ["pattern_room:orders:create"] });
    for (const role of ["production_management", "owner_group", "root_superuser"]) {
      await transaction(async (repo, c) => {
        const current = (await repo.current())!;
        const next = await service.publishNewStandard(c, actor([role]), { expectedVersion: current.version, values: current.values, reason: role, requestKey: randomUUID() });
        expect(next.version).toBe(current.version + 1);
      });
    }
    await expect(transaction(async (repo, c) => {
      const current = (await repo.current())!;
      return service.publishNewStandard(c, actor(["sample_designer"]), { expectedVersion: current.version, values: current.values, reason: "not allowed", requestKey: randomUUID() });
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("routes an old editor through the same standard without rewriting order snapshots", async () => {
    const actor: TrustedActorContext = { actorId, actorRoles: ["owner_group"], requestId: "old-editor",
      authorizationCapability: "pattern_room:orders:create", authorizationCapabilities: ["pattern_room:orders:create"] };
    await transaction(async (repo, c) => {
      const policy = (await c.query("SELECT version FROM digital_production_deadline_policies WHERE node_key='production_sheet' ORDER BY version DESC LIMIT 1")).rows[0];
      const result = await new SlaConfigurationService().changeLegacyPolicy(c, actor, "production_sheet", { expectedVersion: policy.version, slaHours: 80, warningRatio: 0.7, note: "new orders only" }, randomUUID());
      expect(result).toMatchObject({ affectedTasks: 0, scope: "new_orders" });
      expect((await repo.current())!.values.production_sheet).toEqual({ kind: "duration", minutes: 4800 });
      expect((await repo.orderSnapshot(orderId, 1))!.snapshot.parameters.production_sheet!.value).toEqual({ kind: "duration", minutes: 4320 });
      await expect(new SlaConfigurationService().changeLegacyPolicy(c, actor, "production_sheet", { expectedVersion: policy.version, slaHours: 90, warningRatio: 0.7, note: "stale" }, randomUUID())).rejects.toBeInstanceOf(SlaVersionConflict);
    });
  });
  it("reads a persisted pre-reference publication without replacing its history with the latest policy", async () => {
    const c = await db.connect();
    try {
      await c.query("BEGIN");
      const repo = new SlaConfigurationRepository(c);
      const version = (await repo.current())!.version + 1;
      const legacyValues = digitalSlaDefaults();
      legacyValues.production_sheet = { kind: "duration", minutes: 4500 };
      const configurationId = randomUUID();
      await c.query(`INSERT INTO digital_sla_configurations(configuration_id,version,rule_version,values_json,created_by,reason,request_key)
        SELECT $1,$2,rule_version,$3,$4,'legacy publication',$5 FROM digital_sla_configurations ORDER BY version DESC LIMIT 1`,
      [configurationId, version, JSON.stringify(legacyValues), actorId, randomUUID()]);
      expect((await repo.current())!.values).toEqual(legacyValues);
      const snapshot = resolveDigitalSlaSnapshot({ version, values: legacyValues });
      const revision = (await repo.orderSnapshot(orderId))!.revision + 1;
      await repo.appendOrder({ orderId, expectedRevision: revision - 1, configurationId, snapshot, actorId, reason: "legacy frozen order", requestKey: randomUUID() });
      const newer = digitalSlaDefaults(); newer.production_sheet = { kind: "duration", minutes: 6100 };
      await repo.publish({ expectedVersion: version, values: newer, actorId, reason: "later policy", requestKey: randomUUID() });
      const row = (await c.query("SELECT * FROM digital_sla_configurations WHERE configuration_id=$1", [configurationId])).rows[0];
      expect(row.policy_refs_json).toBeNull();
      expect(await readSlaPolicyValues(c, row.policy_refs_json ?? row.values_json)).toEqual(legacyValues);
      expect((await repo.orderSnapshot(orderId, revision))!.snapshot).toEqual(snapshot);
      // The same legacy publication remains a valid source after newer policies exist.
      await repo.appendOrder({ orderId, expectedRevision: revision, configurationId, snapshot, actorId, reason: "explicit legacy source", requestKey: randomUUID() });
    } finally { await c.query("ROLLBACK"); c.release(); }
  });
  it("commits policy references, resolved compatibility values and order snapshot as one unit", async () => {
    const before = (await db.query("SELECT count(*) n FROM digital_sla_configurations")).rows[0].n;
    await transaction(async (repo, c) => {
      const current = (await repo.current())!;
      const values = structuredClone(current.values); values.production_sheet = { kind: "duration", minutes: 6200 };
      const next = await repo.publish({ expectedVersion: current.version, values, actorId, reason: "atomic publication", requestKey: randomUUID() });
      const row = (await c.query("SELECT * FROM digital_sla_configurations WHERE configuration_id=$1", [next.configurationId])).rows[0];
      expect(await readSlaPolicyValues(c, row.policy_refs_json)).toEqual(row.values_json);
      expect(row.values_json).toEqual(values);
      expect((await c.query("SELECT current_setting('dx.sla_policy_publication',true) value")).rows[0].value).not.toBe("on");
      const revision = (await repo.orderSnapshot(orderId))!.revision;
      await repo.appendOrder({ orderId, expectedRevision: revision, configurationId: next.configurationId,
        snapshot: resolveDigitalSlaSnapshot({ version: next.version, values }), actorId, reason: "atomic order", requestKey: randomUUID() });
      // Another connection cannot observe the publication while this transaction is open.
      expect((await db.query("SELECT count(*) n FROM digital_sla_configurations")).rows[0].n).toBe(before);
    });
    await transaction(async (repo, c) => {
      const current = (await repo.current())!;
      const row = (await c.query("SELECT * FROM digital_sla_configurations WHERE configuration_id=$1", [current.configurationId])).rows[0];
      expect(await readSlaPolicyValues(c, row.policy_refs_json)).toEqual(row.values_json);
      expect((await repo.orderSnapshot(orderId))!.configurationId).toBe(current.configurationId);
    });
  });
  it("rolls back all policy versions, publication and order snapshot when downstream publication fails", async () => {
    const counts = async () => (await db.query(`SELECT
      (SELECT count(*) FROM digital_production_deadline_policies) policies,
      (SELECT count(*) FROM digital_sla_configurations) configurations,
      (SELECT count(*) FROM digital_sla_order_snapshots) snapshots`)).rows[0];
    const before = await counts();
    await expect(transaction(async (repo) => {
      const current = (await repo.current())!;
      const values = structuredClone(current.values); values.production_sheet = { kind: "duration", minutes: 6300 };
      const next = await repo.publish({ expectedVersion: current.version, values, actorId, reason: "must roll back", requestKey: randomUUID() });
      await repo.appendOrder({ orderId, expectedRevision: (await repo.orderSnapshot(orderId))!.revision,
        configurationId: next.configurationId, snapshot: resolveDigitalSlaSnapshot({ version: next.version, values }),
        actorId, reason: "must roll back", requestKey: randomUUID() });
      throw new Error("publication transaction failed");
    })).rejects.toThrow("publication transaction failed");
    expect(await counts()).toEqual(before);
  });
});
