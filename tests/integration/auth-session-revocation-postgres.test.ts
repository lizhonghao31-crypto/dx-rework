import {vi as correctnessBudget} from 'vitest';
import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("atomic identity session revocation", () => {
  const schema = ownedPostgresSchema('auth_revoke');
  const admin = new pg.Pool({ connectionString: databaseUrl });
  const database = new pg.Pool({ connectionString: databaseUrl, options: `-c search_path=${schema}` });
  beforeAll(async () => {
    await createOwnedPostgresSchema(admin,schema);
    const manifest = JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url), "utf8")) as { migrations: { version: string; checksum: string }[] };
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const migration of manifest.migrations) {
      await database.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url), "utf8"));
      await database.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [migration.version, migration.checksum]);
    }
  }, testExecutionConfig.correctnessTimeoutMs);
  afterAll(async () => { await database.end(); await releaseOwnedPostgresSchema(admin,schema); await admin.end(); });
  it("revokes every old token with missing membership and permits a new login after restoration", async () => {
    const store = new PostgresAuthStore(database, "corp", "root-fixture");
    const member = { corpId: "corp", userId: "root-fixture", unionId: "root-union", displayName: "fixture", active: true, employed: true };
    const user = await store.upsertIdentity(member);
    for (const tokenHash of ["old-one", "old-two"]) await store.createSession({ id: randomUUID(), tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    await store.deactivateIdentity(user.id, new Date());
    await store.upsertIdentity(member);
    expect(await store.findSession("old-one", new Date())).toBeNull();
    expect(await store.findSession("old-two", new Date())).toBeNull();
    await store.createSession({ id: randomUUID(), tokenHash: "new-token", userId: user.id, expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    expect(await store.findSession("new-token", new Date())).toMatchObject({ userId: user.id });
  });
  it.each([{ active: false, employed: true }, { active: true, employed: false }])("revokes on directory upsert even when Root access remains enabled: %j", async (state) => {
    const providerId = randomUUID(); const store = new PostgresAuthStore(database, "corp", providerId);
    const member = { corpId: "corp", userId: providerId, unionId: providerId, displayName: "fixture", active: true, employed: true };
    const user = await store.upsertIdentity(member); const tokenHash = randomUUID();
    await store.createSession({ id: randomUUID(), tokenHash, userId: user.id, expiresAt: new Date(Date.now() + 60_000), revokedAt: null });
    await store.upsertIdentity({ ...member, ...state }); await store.upsertIdentity(member);
    expect(await store.findSession(tokenHash, new Date())).toBeNull();
    expect((await database.query("SELECT enabled FROM app_users WHERE id=$1", [user.id])).rows[0].enabled).toBe(true);
  });
});
