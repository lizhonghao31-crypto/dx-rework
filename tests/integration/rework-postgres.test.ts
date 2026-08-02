import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("QC rework initiation PostgreSQL contracts", () => {
  const schema = `rework_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const service = new ReworkInitiationService(database, "corp");
  const qcId = randomUUID();
  const otherQcId = randomUUID();
  const merchandiserId = randomUUID();
  const qcActor = (requestId = randomUUID()): TrustedActorContext => ({
    actorId: qcId,
    actorRoles: ["quality_control"],
    authorizationCapability: "rework:initiate",
    requestId,
  });
  const otherQcActor = (): TrustedActorContext => ({
    actorId: otherQcId,
    actorRoles: ["quality_control"],
    authorizationCapability: "rework:initiate",
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
      "0006_rework_initiation.sql",
    ]) {
      const sql = await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      );
      await database.query(sql);
    }
    for (const [userId, displayName] of [
      [qcId, "品控一"],
      [otherQcId, "品控二"],
      [merchandiserId, "订单跟单"],
    ] as const) {
      await database.query(
        "INSERT INTO app_users(id,display_name) VALUES($1,$2)",
        [userId, displayName],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, `ding-${userId}`, `union-${userId}`],
      );
    }
    await database.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES
       ($1,$2,'quality_control',$2,'controlled bootstrap'),
       ($3,$4,'quality_control',$4,'controlled bootstrap'),
       ($5,$6,'order_merchandiser',$6,'controlled bootstrap')`,
      [
        randomUUID(), qcId,
        randomUUID(), otherQcId,
        randomUUID(), merchandiserId,
      ],
    );
    await database.query(
      "INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','corp')",
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("reuses one idempotent draft and rejects changed semantics", async () => {
    const key = randomUUID();
    const first = await service.createDraft(qcActor(), { styleNo: "PD20529725" }, key);
    const replay = await service.createDraft(qcActor(), { styleNo: "PD20529725" }, key);
    expect(replay.reused).toBe(true);
    expect(replay.value.reworkOrderId).toBe(first.value.reworkOrderId);
    expect((await database.query(
      "SELECT 1 FROM rework_orders WHERE created_by=$1",
      [qcId],
    )).rowCount).toBe(1);
    await expect(service.createDraft(
      qcActor(),
      { styleNo: "PD20529726" },
      key,
    )).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
  });

  it("atomically binds ready QC evidence, submits once and warns without merging same styles", async () => {
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'qc.pdf','application/pdf',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.pdf`, "a".repeat(64), qcId],
    );
    const draft = await service.createDraft(qcActor(), {
      styleNo: "PD20529725",
      orderNo: "SO-001",
      merchandiserUserId: merchandiserId,
      processingFactory: { type: "own_factory" },
      problemPart: "后浪",
      problemDescription: "针孔，需要拆包返查",
      reworkQuantity: 281,
      attachmentIds: [attachmentId],
    }, randomUUID());
    expect((await database.query(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [attachmentId],
    )).rows[0]).toEqual({
      entity_type: "rework_order",
      entity_id: draft.value.reworkOrderId,
    });

    const submitKey = randomUUID();
    const submitted = await service.submit(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, submitKey);
    const replay = await service.submit(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, submitKey);
    expect(replay.reused).toBe(true);
    expect(submitted.value.reworkNo).toMatch(/^RW-\d{4}-\d{4}-\d{3,}$/);
    expect(submitted.value.status).toBe("pending_process_configuration");
    expect(replay.value.reworkNo).toBe(submitted.value.reworkNo);
    expect((await database.query(
      "SELECT 1 FROM message_outbox WHERE aggregate_id=$1 AND topic='rework.pending_process_configuration'",
      [draft.value.reworkOrderId],
    )).rowCount).toBe(1);

    const sameStyle = await service.createDraft(qcActor(), {
      styleNo: "PD20529725",
    }, randomUUID());
    expect(sameStyle.value.hasOtherOpenStyleOrder).toBe(true);
    expect((await service.getOwn(qcActor(), draft.value.reworkOrderId))
      .hasOtherOpenStyleOrder).toBe(true);
    await expect(database.query(
      "UPDATE rework_orders SET problem_description='绕过服务修改' WHERE rework_order_id=$1",
      [draft.value.reworkOrderId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE attachments SET original_filename='tampered.pdf' WHERE attachment_id=$1",
      [attachmentId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "DELETE FROM attachments WHERE attachment_id=$1",
      [attachmentId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps one number through withdrawal, correction, resubmission and cancellation", async () => {
    const draft = await service.createDraft(qcActor(), {
      styleNo: "PD20611308",
      merchandiserUserId: merchandiserId,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: "线头返修",
      reworkQuantity: 100,
    }, randomUUID());
    const submitted = await service.submit(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID());
    const firstNumber = submitted.value.reworkNo;
    const withdrawn = await service.withdraw(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: submitted.value.version,
      reason: "补充QC说明",
    }, randomUUID());
    expect(withdrawn.value.status).toBe("draft");
    expect(withdrawn.value.reworkNo).toBe(firstNumber);
    const updated = await service.updateDraft(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: withdrawn.value.version,
      problemDescription: "袖口线头返修并复查",
    }, randomUUID());
    const resubmitted = await service.submit(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: updated.value.version,
    }, randomUUID());
    expect(resubmitted.value.reworkNo).toBe(firstNumber);
    const cancelled = await service.cancel(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: resubmitted.value.version,
      reason: "现场确认无需继续返工",
    }, randomUUID());
    expect(cancelled.value.status).toBe("cancelled");
    expect(cancelled.value.attachmentIds).toEqual([]);
    await expect(service.withdraw(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: cancelled.value.version,
      reason: "非法恢复",
    }, randomUUID())).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });
    const actions = await database.query<{ action: string }>(
      `SELECT action FROM operation_events
       WHERE entity_type='rework_order' AND entity_id=$1
       ORDER BY created_at,event_id`,
      [draft.value.reworkOrderId],
    );
    expect(actions.rows.map((row) => row.action)).toEqual([
      "rework.draft.create",
      "rework.submit",
      "rework.withdraw",
      "rework.draft.update",
      "rework.submit",
      "rework.cancel",
    ]);
  });

  it("rejects stale versions, foreign drafts and foreign or pending attachments", async () => {
    const draft = await service.createDraft(qcActor(), {}, randomUUID());
    await expect(service.updateDraft(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version + 1,
      styleNo: "STALE",
    }, randomUUID())).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    await expect(service.getOwn(otherQcActor(), draft.value.reworkOrderId))
      .rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const foreignAttachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status
       ) VALUES($1,$2,'foreign.png','image/png',10,$3,$4,'pending')`,
      [
        foreignAttachmentId,
        `private/${foreignAttachmentId}.png`,
        "b".repeat(64),
        otherQcId,
      ],
    );
    await expect(service.updateDraft(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
      attachmentIds: [foreignAttachmentId],
    }, randomUUID())).rejects.toMatchObject({
      code: "ATTACHMENT_NOT_READY",
      statusCode: 409,
    });
  });

  it("rejects a trusted-looking audit event when its complete business snapshot differs", async () => {
    const draft = await service.createDraft(qcActor(), {
      styleNo: "PD20611309",
      problemDescription: "已审计的问题描述",
    }, randomUUID());
    const client = await database.connect();
    const eventId = randomUUID();
    const requestId = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,after_state
         ) VALUES(
           $1,$2,$3,ARRAY['quality_control'],'rework:initiate',
           'rework.draft.update','rework_order',$4,
           jsonb_build_object(
             'reworkOrderId',$4,'reworkNo',NULL,'status','draft',
             'styleNo','PD20611309','orderNo',NULL,'merchandiserUserId',NULL,
             'processingFactory',NULL,'problemPart',NULL,
             'problemDescription','已审计的问题描述','reworkQuantity',NULL,
             'attachmentIds',jsonb_build_array(),'version',2
           )
         )`,
        [eventId, requestId, qcId, draft.value.reworkOrderId],
      );
      await client.query(
        "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
        [eventId, requestId],
      );
      await expect(client.query(
        `UPDATE rework_orders
         SET problem_description='未审计的篡改',updated_by=$2,version=version+1
         WHERE rework_order_id=$1`,
        [draft.value.reworkOrderId, qcId],
      )).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });
});
