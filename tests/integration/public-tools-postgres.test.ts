import { ownedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
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
  const schema = ownedPostgresSchema("tools");
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
    await dropOwnedPostgresSchema(admin,schema);
    await admin.end();
  });

  it("permits one concurrent idempotency owner and reuses its completed result", async () => {
    const key = randomUUID();
    const expiresAt = new Date(Date.now() + 60_000);
    const first = await pool.connect();
    const second = await pool.connect();
    await first.query("BEGIN");
    await second.query("BEGIN");
    const firstAcquisition = await idempotency.begin(first, { scope: "test", actorKey: actorId, key, requestHash: "same", expiresAt });
    expect(firstAcquisition).toMatchObject({ kind: "acquired", acquisitionToken: expect.any(String) });
    const secondAttempt = idempotency.begin(second, { scope: "test", actorKey: actorId, key, requestHash: "same", expiresAt });
    if(firstAcquisition.kind!=="acquired")throw new Error("expected acquisition");
    await idempotency.complete(first, { scope: "test", actorKey: actorId, key, acquisitionToken:firstAcquisition.acquisitionToken, statusCode: 201, response: { ok: true } });
    await first.query("COMMIT");
    await expect(secondAttempt).resolves.toMatchObject({ kind: "completed", statusCode: 201, response: { ok: true } });
    await second.query("COMMIT");
    first.release();
    second.release();
  });

  it("atomically takes over an expired key, fences the stale owner and keeps active payload conflicts", async () => {
    const key = randomUUID();
    const stale=await idempotency.begin(pool,{scope:"test",actorKey:actorId,key,requestHash:"old",expiresAt:new Date(Date.now()+60_000)});
    if(stale.kind!=="acquired")throw new Error("expected stale acquisition");
    await pool.query("UPDATE idempotency_records SET expires_at=CURRENT_TIMESTAMP-interval '1 minute' WHERE scope='test' AND actor_key=$1 AND idempotency_key=$2",[actorId,key]);
    const current=await idempotency.begin(pool,{scope:"test",actorKey:actorId,key,requestHash:"new",expiresAt:new Date(Date.now()+60_000)});
    if(current.kind!=="acquired")throw new Error("expected current acquisition");
    await expect(idempotency.complete(pool,{scope:"test",actorKey:actorId,key,acquisitionToken:stale.acquisitionToken,statusCode:200,response:{stale:true}})).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION",statusCode:409});
    await idempotency.complete(pool,{scope:"test",actorKey:actorId,key,acquisitionToken:current.acquisitionToken,statusCode:200,response:{renewed:true}});
    await expect(idempotency.begin(pool, { scope: "test", actorKey: actorId, key, requestHash: "different", expiresAt: new Date(Date.now() + 60_000) })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
  });

  it("reclaims one expired outbox lease without duplicate SKIP LOCKED delivery", async () => {
    const id = await outbox.enqueue(pool, { topic: "lease", aggregateType: "order", aggregateId: "1", payload: { ok: true }, recipientKey: actorId, idempotencyKey: randomUUID() });
    const staleToken=randomUUID();
    await pool.query("UPDATE message_outbox SET status='processing',claimed_at=CURRENT_TIMESTAMP-interval '10 minutes',claim_token=$2 WHERE event_id=$1", [id,staleToken]);
    const first = await pool.connect();
    const second = await pool.connect();
    await first.query("BEGIN");
    await second.query("BEGIN");
    const claimedFirst = await outbox.claim(first, 1, 300);
    const claimedSecond = await outbox.claim(second, 1, 300);
    expect([...claimedFirst, ...claimedSecond].filter((item) => item.eventId === id)).toHaveLength(1);
    expect(claimedFirst[0]).toMatchObject({
      eventId: id,
      topic: "lease",
      aggregateType: "order",
      aggregateId: "1",
      recipientKey: actorId,
      claimToken: expect.any(String),
    });
    await first.query("COMMIT");
    await second.query("COMMIT");
    first.release();
    second.release();
    const currentToken=claimedFirst[0]!.claimToken;
    await expect(outbox.markFailed(pool,id,staleToken,new Error("stale"),30)).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION",statusCode:409});
    await expect(outbox.markSent(pool,id,staleToken)).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION",statusCode:409});
    await outbox.markSent(pool,id,currentToken);
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
    const actor = { actorId, actorRoles: ["owner_group"], authorizationCapability: "tools:user", requestId: randomUUID() };
    const created = await service.create(actor, { exportType: "test", filters: { a: 1 }, idempotencyKey: key });
    expect((await service.create(actor, { exportType: "test", filters: { a: 1 }, idempotencyKey: key })).exportJobId).toBe(created.exportJobId);
    await expect(service.create(actor, { exportType: "test", filters: { a: 2 }, idempotencyKey: key })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await pool.query("UPDATE export_jobs SET status='running',claimed_at=CURRENT_TIMESTAMP-interval '10 minutes',claim_token=$2 WHERE export_job_id=$1", [created.exportJobId,randomUUID()]);
    expect((await service.claim(pool, 10, 300)).map((row) => row.export_job_id)).toContain(created.exportJobId);
  });

  it("completes exports only with ready attachments owned by the requester or bound to the job", async () => {
    const service = new ExportJobService(pool);
    const actor = { actorId, actorRoles: ["owner_group"], authorizationCapability: "tools:user", requestId: randomUUID() };
    const job = await service.create(actor, { exportType: "ready-check", filters: {}, idempotencyKey: randomUUID() });
    const claimed=(await service.claim(pool,10,300)).find((row)=>row.export_job_id===job.exportJobId);
    if(!claimed?.claim_token)throw new Error("expected export claim token");
    const attachmentId = randomUUID();
    await pool.query(
      `INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status)
       VALUES($1,$2,'result.pdf','application/pdf',1,$3,$4,'pending')`,
      [attachmentId, `private/${attachmentId}.pdf`, "a".repeat(64), actorId],
    );
    await expect(service.complete(pool, job.exportJobId, claimed.claim_token, attachmentId)).rejects.toMatchObject({ code: "INVALID_STATE_TRANSITION", statusCode: 409 });
    await pool.query("UPDATE attachments SET status='ready',ready_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [attachmentId]);
    await expect(service.complete(pool, job.exportJobId, claimed.claim_token, attachmentId)).resolves.toBeUndefined();
    expect((await service.query(actorId, job.exportJobId)).status).toBe("succeeded");
  });

  it("rejects inconsistent persisted states and blocks audit truncation", async () => {
    const attachmentId = randomUUID();
    await expect(pool.query(
      "INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status) VALUES($1,$2,'bad.pdf','application/pdf',1,$3,$4,'ready')",
      [attachmentId, "private/" + attachmentId + ".pdf", "c".repeat(64), actorId],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      "INSERT INTO message_outbox(event_id,topic,aggregate_type,aggregate_id,payload,recipient_key,idempotency_key,status,claim_token) VALUES($1,'bad','order','1','{}',$2,$3,'processing',$4)",
      [randomUUID(), actorId, randomUUID(), randomUUID()],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      "INSERT INTO message_outbox(event_id,topic,aggregate_type,aggregate_id,payload,recipient_key,idempotency_key,status) VALUES($1,'bad-failure','order','1','{}',$2,$3,'failed')",
      [randomUUID(), actorId, randomUUID()],
    )).rejects.toMatchObject({ code: "23514" });

    await expect(pool.query(
      "INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id) VALUES($1,'request',$2,ARRAY['employee'],'tools:user','test','test','1')",
      [randomUUID(), actorId],
    )).resolves.toMatchObject({ rowCount: 1 });
    await expect(pool.query("TRUNCATE operation_events")).rejects.toMatchObject({ code: "55000" });
  });

  it("fences stale export completion and failure after lease reclaim",async()=>{
    const service=new ExportJobService(pool);const actor={actorId,actorRoles:["owner_group"],authorizationCapability:"tools:user",requestId:randomUUID()};
    const job=await service.create(actor,{exportType:"lease-fence",filters:{},idempotencyKey:randomUUID()});
    const first=(await service.claim(pool,10,300)).find((row)=>row.export_job_id===job.exportJobId);if(!first?.claim_token)throw new Error("expected first claim");
    await pool.query("UPDATE export_jobs SET claimed_at=CURRENT_TIMESTAMP-interval '10 minutes' WHERE export_job_id=$1",[job.exportJobId]);
    const second=(await service.claim(pool,10,300)).find((row)=>row.export_job_id===job.exportJobId);if(!second?.claim_token)throw new Error("expected reclaimed claim");
    const attachmentId=randomUUID();await pool.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'lease.pdf','application/pdf',1,$3,$4,'ready',CURRENT_TIMESTAMP)`,[attachmentId,`private/${attachmentId}.pdf`,"b".repeat(64),actorId]);
    await expect(service.fail(pool,job.exportJobId,first.claim_token,new Error("stale"))).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION",statusCode:409});
    await expect(service.complete(pool,job.exportJobId,first.claim_token,attachmentId)).rejects.toMatchObject({code:"INVALID_STATE_TRANSITION",statusCode:409});
    await expect(service.complete(pool,job.exportJobId,second.claim_token,attachmentId)).resolves.toBeUndefined();
  });
});