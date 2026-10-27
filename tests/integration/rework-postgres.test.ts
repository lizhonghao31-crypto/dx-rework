import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { applyMigrations, discoverValidatedMigrations } from "../../scripts/migration-lib.mjs";
import { assertTestDatabaseTarget } from "../../scripts/test-database-safety.mjs";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { completeInspectionReport } from "../inspection-report-fixture.js";

import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("QC rework initiation PostgreSQL contracts", () => {
  const schema = ownedPostgresSchema("rework");
  let schemaCreated = false;
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
  const supplementActor = (): TrustedActorContext => ({
    ...qcActor(),
    authorizationCapability: "tools:user",
  });
  const rootActor = (): TrustedActorContext => ({
    actorId: qcId,
    actorRoles: ["root_superuser"],
    authorizationCapability: "rework:delete",
    authorizationCapabilities: ["rework:delete"],
    requestId: randomUUID(),
  });

  beforeAll(async () => {
    await assertTestDatabaseTarget(databaseUrl!);
    await admin.query(`CREATE SCHEMA ${schema}`);
    schemaCreated = true;
    const scoped = new URL(databaseUrl!);
    scoped.searchParams.set("options", `-c search_path=${schema}`);
    const migrations = await discoverValidatedMigrations();
    const initialized = await applyMigrations(scoped.toString());
    expect(initialized.currentVersion).toBe(migrations.at(-1)!.version);
    expect(initialized.applied).toHaveLength(migrations.length);
    expect((await database.query("SELECT current_schema() AS schema")).rows[0].schema).toBe(schema);
    expect((await database.query("SELECT version,checksum FROM schema_migrations ORDER BY version")).rows)
      .toEqual(migrations.map(({ version, checksum }) => ({ version, checksum })));
    expect((await applyMigrations(scoped.toString())).applied).toEqual([]);
    for (const [userId, displayName] of [
      [qcId, "品控一"],
      [otherQcId, "品控二"],
      [merchandiserId, "订单跟单"],
    ] as const) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
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
    try {
      if (schemaCreated) {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
        expect((await admin.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [schema])).rowCount).toBe(0);
      }
    } finally {
      await admin.end();
    }
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
       ) VALUES($1,$2,'qc.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.webp`, "a".repeat(64), qcId],
    );
    const draft = await service.createDraft(qcActor(), {
      styleNo: "PD20529725",
      orderNo: "SO-001",
      orderQuantity: 281,
      tailInspectionCostBearer: "own_factory",
      inspectionReport: completeInspectionReport(),
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

    const supplementalImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'supplemental.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [supplementalImageId, `private/${supplementalImageId}.webp`, "c".repeat(64), qcId],
    );
    const supplemented = await service.supplementOrderImages(supplementActor(), draft.value.reworkOrderId, {
      expectedVersion: submitted.value.version,
      attachmentIds: [supplementalImageId],
    }, randomUUID());
    expect(supplemented.value.version).toBe(submitted.value.version + 1);
    expect(supplemented.value.attachmentIds).toEqual([attachmentId, supplementalImageId]);
    expect((await database.query(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [supplementalImageId],
    )).rows[0]).toEqual({ entity_type: "rework_order", entity_id: draft.value.reworkOrderId });
    expect((await database.query<{ action: string }>(
      "SELECT action FROM operation_events WHERE entity_type='rework_order' AND entity_id=$1 ORDER BY created_at,event_id",
      [draft.value.reworkOrderId],
    )).rows.map((row) => row.action)).toContain("rework.attachments.supplement");

    const nonImageId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'not-an-image.pdf','application/pdf',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [nonImageId, `private/${nonImageId}.pdf`, "d".repeat(64), qcId],
    );
    await expect(service.supplementOrderImages(supplementActor(), draft.value.reworkOrderId, {
      expectedVersion: supplemented.value.version,
      attachmentIds: [nonImageId],
    }, randomUUID())).rejects.toMatchObject({ code: "ATTACHMENT_NOT_READY", statusCode: 409 });
    await expect(service.supplementOrderImages(supplementActor(), draft.value.reworkOrderId, {
      expectedVersion: supplemented.value.version,
      attachmentIds: Array.from({ length: 7 }, () => randomUUID()),
    }, randomUUID())).rejects.toMatchObject({ code: "VALIDATION_ERROR", statusCode: 400 });

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
    const attachmentId = randomUUID();
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,
         sha256,uploaded_by,status,ready_at
       ) VALUES($1,$2,'withdrawal.webp','image/webp',10,$3,$4,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `private/${attachmentId}.webp`, "e".repeat(64), qcId],
    );
    const draft = await service.createDraft(qcActor(), {
      styleNo: "PD20611308",
      orderQuantity: 100,
      tailInspectionCostBearer: "own_factory",
      inspectionReport: completeInspectionReport(),
      merchandiserUserId: merchandiserId,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: "线头返修",
      reworkQuantity: 100,
      attachmentIds: [attachmentId],
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
    expect(cancelled.value.attachmentIds).toEqual([attachmentId]);
    expect((await database.query(
      "SELECT entity_type,entity_id,status FROM attachments WHERE attachment_id=$1",
      [attachmentId],
    )).rows).toEqual([{
      entity_type: "rework_order",
      entity_id: draft.value.reworkOrderId,
      status: "ready",
    }]);
    expect((await database.query(
      "SELECT before_state,after_state FROM operation_events WHERE entity_id=$1 AND action='rework.cancel'",
      [draft.value.reworkOrderId],
    )).rows).toMatchObject([{
      before_state: { attachmentIds: [attachmentId] },
      after_state: { attachmentIds: [attachmentId] },
    }]);
    await expect(service.supplementOrderImages(supplementActor(), draft.value.reworkOrderId, {
      expectedVersion: cancelled.value.version,
      attachmentIds: [randomUUID()],
    }, randomUUID())).rejects.toMatchObject({
      code: "INVALID_STATE_TRANSITION",
      statusCode: 409,
    });
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

  it("rejects N01 submission without a ready image even when all other order facts are present", async () => {
    const draft = await service.createDraft(qcActor(), {
      styleNo: "N01-NO-IMAGE",
      orderQuantity: 1,
      tailInspectionCostBearer: "own_factory",
      inspectionReport: completeInspectionReport(),
      merchandiserUserId: merchandiserId,
      processingFactory: { type: "own_factory" },
      problemPart: "袖口",
      problemDescription: "缺少现场图片",
      reworkQuantity: 1,
    }, randomUUID());

    await expect(service.submit(qcActor(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
    }, randomUUID())).rejects.toMatchObject({
      code: "REWORK_IMAGE_REQUIRED",
      statusCode: 400,
    });
  });

  it("allows only root to logically delete once while retaining immutable order evidence", async () => {
    const draft = await service.createDraft(qcActor(), { styleNo: "DELETE-ONE" }, randomUUID());
    await expect(service.deleteByRoot(qcActor(), draft.value.reworkOrderId, randomUUID()))
      .rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    const key = randomUUID();
    const deleted = await service.deleteByRoot(rootActor(), draft.value.reworkOrderId, key);
    const replay = await service.deleteByRoot(rootActor(), draft.value.reworkOrderId, key);
    expect(deleted).toEqual({ value: { reworkOrderId: draft.value.reworkOrderId, deleted: true }, reused: false });
    expect(replay).toEqual({ value: { reworkOrderId: draft.value.reworkOrderId, deleted: true }, reused: true });
    await expect(service.getOwn(qcActor(), draft.value.reworkOrderId)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    await expect(database.query(
      "UPDATE rework_orders SET style_no='tampered' WHERE rework_order_id=$1",
      [draft.value.reworkOrderId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "SELECT status,deleted_at,deleted_by FROM rework_orders WHERE rework_order_id=$1",
      [draft.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ status: "deleted", deleted_at: expect.any(Date), deleted_by: qcId }] });
    await expect(database.query(
      "SELECT action,authorization_capability FROM operation_events WHERE entity_type='rework_order' AND entity_id=$1 ORDER BY created_at DESC,event_id DESC LIMIT 1",
      [draft.value.reworkOrderId],
    )).resolves.toMatchObject({ rows: [{ action: "rework.delete", authorization_capability: "rework:delete" }] });
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
    const originalState = (await database.query<{ after_state: Record<string, unknown> }>(
      "SELECT after_state FROM operation_events WHERE entity_id=$1 AND action='rework.draft.create'",
      [draft.value.reworkOrderId],
    )).rows[0]!.after_state;
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,after_state
         ) VALUES(
           $1,$2,$3,ARRAY['quality_control'],'rework:initiate',
           'rework.draft.update','rework_order',$4::text,$5::jsonb
         )`,
        [eventId, requestId, qcId, draft.value.reworkOrderId,
          JSON.stringify({ ...originalState, version: 2 })],
      );
      await client.query(
        "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
        [eventId, requestId],
      );
      await client.query("SAVEPOINT mismatched_snapshot");
      await expect(client.query(
        `UPDATE rework_orders
         SET problem_description='未审计的篡改',updated_by=$2,version=version+1
         WHERE rework_order_id=$1`,
        [draft.value.reworkOrderId, qcId],
      )).rejects.toMatchObject({ code: "55000" });
      await client.query("ROLLBACK TO SAVEPOINT mismatched_snapshot");
      // The same complete event accepts its actual snapshot. This prevents a
      // missing newer field from masquerading as the intended mismatch check.
      await client.query(
        `UPDATE rework_orders SET problem_description=$2,updated_by=$3,version=version+1
         WHERE rework_order_id=$1`,
        [draft.value.reworkOrderId, originalState.problemDescription, qcId],
      );
      await client.query("ROLLBACK");
      expect((await service.getOwn(qcActor(), draft.value.reworkOrderId)).version).toBe(draft.value.version);
      expect((await database.query("SELECT 1 FROM operation_events WHERE event_id=$1", [eventId])).rowCount).toBe(0);
    } finally {
      client.release();
    }
  });
});
