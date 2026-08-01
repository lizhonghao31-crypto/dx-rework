import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ExportJobService } from "../../apps/api/src/tools/exports.js";
import { IdempotencyRepository, MessageOutboxRepository } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("public tools PostgreSQL concurrency contracts", () => {
  const schema = `tools_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const pool = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const idempotency = new IdempotencyRepository();
  const outbox = new MessageOutboxRepository();
  const actorId = randomUUID();

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0003_identity_union_continuity.sql", "0004_public_tools_foundation.sql"]) {
      const sql = await readFile(new URL(`../../apps/api/migrations/${migration}`, import.meta.url), "utf8");
      await pool.query(sql);
    }
    await pool.query("INSERT INTO app_users(id,display_name) VALUES($1,'tools-test')", [actorId]);
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("permits one concurrent idempotency owner and reuses its completed result", async () => {
    const key = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const first = await pool.connect();
    const second = await pool.connect();
    await first.query("BEGIN");
    await second.query("BEGIN");
    expect(await idempotency.begin(first, { scope: "test", actorKey: actorId, key, requestHash: "same", expiresAt })).toEqual({ kind: "acquired" });
    const secondAttempt = idempotency.begin(second, { scope: "test", actorKey: actorId, key, requestHash: "same", expiresAt });
    await idempotency.complete(first, { scope: "test", actorKey: actorId, key, statusCode: 201, response: { ok: true } });
    await first.query("COMMIT");
    await expect(secondAttempt).resolves.toMatchObject({ kind: "completed", statusCode: 201, response: { ok: true } });
    await second.query("COMMIT");
    first.release();
    second.release();
  });

  it("atomically takes over an expired key and keeps active payload conflicts", async () => {
    const key = randomUUID();
    await pool.query("INSERT INTO idempotency_records(scope,actor_key,idempotency_key,request_hash,expires_at) VALUES('test',$1,$2,'old',CURRENT_TIMESTAMP-interval '1 minute')", [actorId, key]);
    const client = await pool.connect();
    await client.query("BEGIN");
    await expect(idempotency.begin(client, { scope: "test", actorKey: actorId, key, requestHash: "new", expiresAt: new Date(Date.now() + 60_000) })).resolves.toEqual({ kind: "acquired" });
    await idempotency.complete(client, { scope: "test", actorKey: actorId, key, statusCode: 200, response: { renewed: true } });
    await client.query("COMMIT");
    client.release();
    await expect(idempotency.begin(pool, { scope: "test", actorKey: actorId, key, requestHash: "different", expiresAt: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
  });

  it("reclaims one expired outbox lease without duplicate SKIP LOCKED delivery", async () => {
    const id = await outbox.enqueue(pool, { topic: "lease", aggregateType: "order", aggregateId: "1", payload: { ok: true }, recipientKey: actorId, idempotencyKey: randomUUID() });
    await pool.query("UPDATE message_outbox SET status='processing',claimed_at=CURRENT_TIMESTAMP-interval '10 minutes' WHERE event_id=$1", [id]);
    const first = await pool.connect();
    const second = await pool.connect();
    await first.query("BEGIN");
    await second.query("BEGIN");
    const claimedFirst = await outbox.claim(first, 1, 300);
    const claimedSecond = await outbox.claim(second, 1, 300);
    expect([...claimedFirst, ...claimedSecond].filter((item) => item.eventId === id)).toHaveLength(1);
    await first.query("COMMIT");
    await second.query("COMMIT");
    first.release();
    second.release();
  });

  it("reuses identical outbox payloads and rejects changed semantics", async () => {
    const input = { topic: "semantic", aggregateType: "order", aggregateId: "2", payload: { b: 2, a: 1 }, recipientKey: actorId, idempotencyKey: randomUUID() };
    const id = await outbox.enqueue(pool, input);
    expect(await outbox.enqueue(pool, { ...input, payload: { a: 1, b: 2 } })).toBe(id);
    await expect(outbox.enqueue(pool, { ...input, payload: { a: 3 } })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
  });

  it("rejects changed export filters and reclaims an expired running lease", async () => {
    const service = new ExportJobService(pool);
    const key = randomUUID();
    const actor = { actorId, actorRole: "employee", requestId: randomUUID() };
    const created = await service.create(actor, { exportType: "test", filters: { a: 1 }, idempotencyKey: key });
    expect((await service.create(actor, { exportType: "test", filters: { a: 1 }, idempotencyKey: key })).exportJobId).toBe(created.exportJobId);
    await expect(service.create(actor, { exportType: "test", filters: { a: 2 }, idempotencyKey: key })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await pool.query("UPDATE export_jobs SET status='running',claimed_at=CURRENT_TIMESTAMP-interval '10 minutes' WHERE export_job_id=$1", [created.exportJobId]);
    expect((await service.claim(pool, 10, 300)).map((row) => row.export_job_id)).toContain(created.exportJobId);
  });
});
