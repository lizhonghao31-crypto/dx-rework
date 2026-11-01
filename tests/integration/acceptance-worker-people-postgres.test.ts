import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { maintainAcceptanceWorkerPeople } from "../../scripts/acceptance/worker-people-maintenance.js";
import { ownedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("Acceptance personnel-only maintenance", () => {
  const schema = ownedPostgresSchema("acceptance_people");
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  const corpId = "corp-acceptance";
  const rootId = randomUUID();
  const workerIds = [randomUUID(), randomUUID(), randomUUID()];
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as {
      migrations: { version: string; checksum: string }[];
    };
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const migration of manifest.migrations) {
      await database.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8"));
      await database.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]);
    }
    for (const [id, alias, role] of [
      [rootId, "root", "owner_group"], [workerIds[0]!, "worker-a", "worker"],
      [workerIds[1]!, "worker-b", "worker"], [workerIds[2]!, "pattern-room-worker", "pattern_room_worker"],
    ]) {
      await database.query("INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)", [id, `[UAT] ${alias}`]);
      await database.query(`INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
        VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`, [randomUUID(), id, corpId, `uat-${alias}`, `uat-union-${alias}`]);
      await database.query(`INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
        VALUES($1,$2,$3,$4,'TEST isolated standard identities')`, [randomUUID(), id, role, rootId]);
    }
    await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'uat-root',$2)", [rootId, corpId]);
    await new AccessMasterDataService(database, corpId).ensureOrganizationPolicy();
  });
  afterAll(async () => {
    await database.end();
    await dropOwnedPostgresSchema(admin, schema);
    await admin.end();
  });

  it("checks without writes, refuses inactive identities, creates only three audited internal people and retries idempotently", async () => {
    const snapshot = async () => Promise.all(["app_users", "identity_mappings", "user_role_assignments"].map(async table =>
      (await database.query(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows));
    const before = await snapshot();
    const missing = await maintainAcceptanceWorkerPeople(database, corpId);
    expect(missing.ready).toBe(false);
    expect(missing.workers.map(worker => worker.status)).toEqual(["missing", "missing", "missing"]);
    expect((await database.query("SELECT 1 FROM business_people")).rowCount).toBe(0);
    expect(await snapshot()).toEqual(before);
    await expect(maintainAcceptanceWorkerPeople(database, corpId, true)).rejects.toThrow("Apply requires both");
    await expect(maintainAcceptanceWorkerPeople(database, corpId, true, { alias: "pattern-room-worker" })).rejects.toThrow("Apply requires both");
    const selection = { alias: "pattern-room-worker", expectedUserId: workerIds[2] };
    await database.query("UPDATE identity_mappings SET active=false WHERE user_id=$1", [workerIds[2]]);
    await expect(maintainAcceptanceWorkerPeople(database, corpId, true, selection)).rejects.toThrow("inactive");
    expect((await database.query("SELECT 1 FROM business_people")).rowCount).toBe(0);
    await database.query("UPDATE identity_mappings SET active=true WHERE user_id=$1", [workerIds[2]]);
    await expect(maintainAcceptanceWorkerPeople(database, corpId, true, {
      alias: "pattern-room-worker", expectedUserId: randomUUID(),
    })).rejects.toThrow("expected user ID");
    expect((await database.query("SELECT 1 FROM business_people")).rowCount).toBe(0);
    const selected = await maintainAcceptanceWorkerPeople(database, corpId, true, {
      alias: "pattern-room-worker", expectedUserId: workerIds[2],
    });
    expect(selected.workers).toHaveLength(1);
    expect(selected.ready).toBe(true);
    expect((await database.query("SELECT 1 FROM business_people")).rowCount).toBe(1);
    // Other standard workers require their own explicit, identity-pinned operation.
    for (const [index, alias] of ["worker-a", "worker-b"].entries()) {
      expect((await maintainAcceptanceWorkerPeople(database, corpId, true, {
        alias, expectedUserId: workerIds[index],
      })).ready).toBe(true);
    }
    expect((await database.query("SELECT 1 FROM business_people WHERE person_type='internal' AND active AND app_user_id=ANY($1::uuid[])", [workerIds])).rowCount).toBe(3);
    expect(await snapshot()).toEqual(before);
    expect(await maintainAcceptanceWorkerPeople(database, corpId, true, selection)).toEqual(selected);
    expect((await maintainAcceptanceWorkerPeople(database, corpId)).ready).toBe(true);
    expect((await database.query("SELECT 1 FROM business_people")).rowCount).toBe(3);
  });
});
