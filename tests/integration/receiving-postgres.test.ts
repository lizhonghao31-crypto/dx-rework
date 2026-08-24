import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReceivingService } from "../../apps/api/src/receiving/receiving-service.js";
import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

const businessDate = (): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(new Date());

runWithPostgres("receiving fact PostgreSQL contracts", () => {
  const schema = `receiving_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const service = new ReceivingService(database);
  const reworkService = new ReworkInitiationService(database, "corp");
  const receiverId = randomUUID();

  const receiver = (): TrustedActorContext => ({
    actorId: receiverId,
    actorRoles: ["warehouse_receiver"],
    authorizationCapability: "receiving:create",
    authorizationCapabilities: ["receiving:create"],
    requestId: randomUUID(),
  });

  const initiator = (): TrustedActorContext => ({
    actorId: receiverId,
    actorRoles: ["quality_control"],
    authorizationCapability: "rework:initiate",
    authorizationCapabilities: ["rework:initiate"],
    requestId: randomUUID(),
  });

  const rootCorrector = (): TrustedActorContext => ({
    actorId: receiverId,
    actorRoles: ["root_superuser"],
    authorizationCapability: "receiving:correct",
    authorizationCapabilities: ["receiving:correct"],
    requestId: randomUUID(),
  });

  const migration = async (name: string): Promise<void> => {
    await database.query(await readFile(
      new URL(`../../apps/api/migrations/${name}`, import.meta.url),
      "utf8",
    ));
  };

  const insertLegacyReceipt = async (): Promise<string> => {
    const receiptId = randomUUID();
    const eventId = randomUUID();
    const requestId = randomUUID();
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,after_state
         ) VALUES($1,$2,$3,ARRAY['warehouse_receiver'],'receiving:create',
                  'receiving.receipt.create','receiving_receipt',$4,$5::jsonb)`,
        [eventId, requestId, receiverId, receiptId, JSON.stringify({ receiptId })],
      );
      await client.query(
        "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
        [eventId, requestId],
      );
      await client.query(
        `INSERT INTO receiving_receipts(
           receipt_id,style_no,document_quantity,actual_quantity,
           received_by,operation_event_id,request_id
         ) VALUES($1,'STYLE-LEGACY-01',50,45,$2,$3,$4)`,
        [receiptId, receiverId, eventId, requestId],
      );
      await client.query("COMMIT");
      return receiptId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const readyImage = async (mimeType = "image/jpeg"): Promise<string> => {
    const attachmentId = randomUUID();
    const sha256 = `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "")}`;
    await database.query(
      `INSERT INTO attachments(
         attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
         uploaded_by,status,ready_at
       ) VALUES($1,$2,$3,$4,100,$5,$6,'ready',CURRENT_TIMESTAMP)`,
      [attachmentId, `receiving-test/${attachmentId}`, `${attachmentId}.jpg`, mimeType, sha256, receiverId],
    );
    return attachmentId;
  };

  const draftAfterState = (reworkOrderId: string, styleNo: string, status: "draft" | "cancelled", version: number, cancelReason?: string) => ({
    reworkOrderId,
    reworkNo: null,
    status,
    styleNo,
    orderNo: null,
    merchandiserUserId: null,
    processingFactory: null,
    problemPart: null,
    problemDescription: null,
    reworkQuantity: null,
    version,
    ...(cancelReason ? { cancelReason } : {}),
  });

  const createReworkDraft = async (styleNo: string): Promise<string> => {
    const reworkOrderId = randomUUID();
    const eventId = randomUUID();
    const requestId = randomUUID();
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,after_state
         ) VALUES($1,$2,$3,ARRAY['quality_control'],'rework:initiate',
                  'rework.draft.create','rework_order',$4,$5::jsonb)`,
        [eventId, requestId, receiverId, reworkOrderId, JSON.stringify(draftAfterState(reworkOrderId, styleNo, "draft", 1))],
      );
      await client.query(
        "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
        [eventId, requestId],
      );
      await client.query(
        `INSERT INTO rework_orders(rework_order_id,style_no,created_by,updated_by)
         VALUES($1,$2,$3,$3)`,
        [reworkOrderId, styleNo, receiverId],
      );
      await client.query("COMMIT");
      return reworkOrderId;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  const cancelReworkDraft = async (reworkOrderId: string, styleNo: string): Promise<void> => {
    const eventId = randomUUID();
    const requestId = randomUUID();
    const reason = "测试取消";
    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,after_state,reason
         ) VALUES($1,$2,$3,ARRAY['quality_control'],'rework:initiate',
                  'rework.cancel','rework_order',$4,$5::jsonb,$6)`,
        [eventId, requestId, receiverId, reworkOrderId, JSON.stringify(draftAfterState(reworkOrderId, styleNo, "cancelled", 2, reason)), reason],
      );
      await client.query(
        "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
        [eventId, requestId],
      );
      await client.query(
        `UPDATE rework_orders
         SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,
             cancel_reason=$3,updated_by=$2,version=2,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, receiverId, reason],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
      "0006_rework_initiation.sql",
      "0044_uat_initiation_context.sql",
      "0056_n01_digital_inspection_report.sql",
      "0076_receiving_fact_layer.sql",
    ]) await migration(name);

    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'仓管测试',true)",
      [receiverId],
    );
    await insertLegacyReceipt();
    await migration("0086_receiving_rework_evidence_link.sql");
    await migration("0088_root_receiving_correction.sql");
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("backfills legacy receipts without changing immutable receiving quantities", async () => {
    const legacy = await database.query<{
      document_quantity: number;
      actual_quantity: number;
      difference_quantity: number;
      receiving_batch_id: string;
    }>(
      `SELECT document_quantity,actual_quantity,difference_quantity,receiving_batch_id
       FROM receiving_receipts WHERE style_no='STYLE-LEGACY-01'`,
    );
    expect(legacy.rows[0]).toMatchObject({
      document_quantity: 50,
      actual_quantity: 45,
      difference_quantity: -5,
    });
    expect(legacy.rows[0]?.receiving_batch_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("requires receiving-note evidence on a new batch, reuses it on later receipts, and keeps cumulative facts", async () => {
    await expect(service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      attachmentIds: [],
    }, randomUUID())).rejects.toThrow("收货单图片必传");

    const firstImage = await readyImage();
    const firstKey = randomUUID();
    const first = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      attachmentIds: [firstImage],
    }, firstKey);
    expect(first.reused).toBe(false);
    expect(first.value).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      differenceQuantity: -20,
      receivedBy: receiverId,
    });

    const binding = await database.query<{ entity_type: string; entity_id: string }>(
      "SELECT entity_type,entity_id FROM attachments WHERE attachment_id=$1",
      [firstImage],
    );
    expect(binding.rows[0]).toEqual({
      entity_type: "receiving_batch",
      entity_id: first.value.receivingBatchId,
    });

    const replay = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      attachmentIds: [firstImage],
    }, firstKey);
    expect(replay.reused).toBe(true);

    const second = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 120,
      attachmentIds: [],
    }, randomUUID());
    expect(second.value.receivingBatchId).toBe(first.value.receivingBatchId);
    expect(second.value.differenceQuantity).toBe(20);

    const board = await service.board(businessDate());
    const row = board.rows.find((item) => item.receivingBatchId === first.value.receivingBatchId);
    expect(row).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 200,
      actualQuantity: 200,
      differenceQuantity: 0,
      receiptCount: 2,
      reworkOrderId: null,
      reworkStatus: null,
    });

    await expect(service.create(receiver(), {
      styleNo: "STYLE-TOO-MANY-IMAGES",
      documentQuantity: 1,
      actualQuantity: 1,
      attachmentIds: [randomUUID(), randomUUID(), randomUUID(), randomUUID()],
    }, randomUUID())).rejects.toThrow("最多3张");

    const facts = await database.query<{ difference_quantity: number }>(
      "SELECT difference_quantity FROM receiving_receipts WHERE receiving_batch_id=$1 ORDER BY received_at,receipt_id",
      [first.value.receivingBatchId],
    );
    expect(facts.rows.map((item) => item.difference_quantity).sort((left, right) => left - right)).toEqual([-20, 20]);
    await expect(database.query(
      "UPDATE receiving_receipts SET actual_quantity=100 WHERE receipt_id=$1",
      [first.value.receiptId],
    )).rejects.toThrow();
  });

  it("rejects unaudited receiving evidence rebinding", async () => {
    const image = await readyImage();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-AUDIT-GUARD",
      documentQuantity: 10,
      actualQuantity: 10,
      attachmentIds: [image],
    }, randomUUID());

    await expect(database.query(
      "UPDATE attachments SET entity_type=NULL,entity_id=NULL WHERE attachment_id=$1",
      [image],
    )).rejects.toThrow("bound receiving evidence is immutable");

    const orphan = await readyImage();
    await expect(database.query(
      "UPDATE attachments SET entity_type='receiving_batch',entity_id=$2 WHERE attachment_id=$1",
      [orphan, receipt.value.receivingBatchId],
    )).rejects.toThrow("receiving attachment binding requires trusted audit context");
  });

  it("lets Root correct and logically delete an unstarted receiving batch without rewriting receipt facts", async () => {
    const image = await readyImage();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-ROOT-CORRECT-01",
      documentQuantity: 30,
      actualQuantity: 27,
      attachmentIds: [image],
    }, randomUUID());

    let board = await service.board(businessDate());
    const before = board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)!;
    expect(before).toMatchObject({ version: 1, rootMutable: true });

    await expect(service.correctBatch(receiver(), receipt.value.receivingBatchId, {
      expectedVersion: before.version,
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
    })).rejects.toThrow("只有Root");

    const corrected = await service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: before.version,
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
    });
    expect(corrected).toMatchObject({
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
      differenceQuantity: -1,
      version: 2,
    });

    const immutableFact = await database.query<{
      style_no: string;
      document_quantity: number;
      actual_quantity: number;
    }>(
      "SELECT style_no,document_quantity,actual_quantity FROM receiving_receipts WHERE receipt_id=$1",
      [receipt.value.receiptId],
    );
    expect(immutableFact.rows[0]).toEqual({
      style_no: "STYLE-ROOT-CORRECT-01",
      document_quantity: 30,
      actual_quantity: 27,
    });

    board = await service.board(businessDate(), "CORRECTED");
    expect(board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)).toMatchObject({
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
      version: 2,
      rootMutable: true,
    });

    await service.deleteBatch(rootCorrector(), receipt.value.receivingBatchId, 2);
    board = await service.board(businessDate());
    expect(board.rows.some((item) => item.receivingBatchId === receipt.value.receivingBatchId)).toBe(false);
    const retained = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM receiving_receipts WHERE receiving_batch_id=$1",
      [receipt.value.receivingBatchId],
    );
    expect(retained.rows[0]?.count).toBe("1");
  });

  it("binds a real server draft to the receiving batch, blocks a duplicate active rework, and reopens after cancellation", async () => {
    const image = await readyImage();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-REWORK-LINK-01",
      documentQuantity: 40,
      actualQuantity: 40,
      attachmentIds: [image],
    }, randomUUID());

    const firstDraftId = await createReworkDraft("STYLE-REWORK-LINK-01");
    const firstLink = await database.query<{ source_receiving_batch_id: string }>(
      "SELECT source_receiving_batch_id FROM rework_orders WHERE rework_order_id=$1",
      [firstDraftId],
    );
    expect(firstLink.rows[0]?.source_receiving_batch_id).toBe(receipt.value.receivingBatchId);

    let board = await service.board(businessDate());
    expect(board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)).toMatchObject({
      reworkOrderId: firstDraftId,
      reworkStatus: "draft",
    });

    await expect(createReworkDraft("STYLE-REWORK-LINK-01"))
      .rejects.toThrow("source receiving batch already has active rework");

    await cancelReworkDraft(firstDraftId, "STYLE-REWORK-LINK-01");
    board = await service.board(businessDate());
    const cancelledRow = board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)!;
    expect(cancelledRow.reworkStatus).toBeNull();
    expect(cancelledRow.rootMutable).toBe(false);
    await expect(service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: cancelledRow.version,
      styleNo: "STYLE-REWORK-LINK-01",
      documentQuantity: 41,
      actualQuantity: 41,
    })).rejects.toThrow("已经发起过返工");
    await expect(service.deleteBatch(rootCorrector(), receipt.value.receivingBatchId, cancelledRow.version))
      .rejects.toThrow("已经发起过返工");

    const secondDraftId = await createReworkDraft("STYLE-REWORK-LINK-01");
    expect(secondDraftId).not.toBe(firstDraftId);
    const secondLink = await database.query<{ source_receiving_batch_id: string }>(
      "SELECT source_receiving_batch_id FROM rework_orders WHERE rework_order_id=$1",
      [secondDraftId],
    );
    expect(secondLink.rows[0]?.source_receiving_batch_id).toBe(receipt.value.receivingBatchId);
  });

  it("records the database-selected batch in the legacy style-only draft audit event", async () => {
    const image = await readyImage();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-LEGACY-DRAFT-AUDIT",
      documentQuantity: 12,
      actualQuantity: 12,
      attachmentIds: [image],
    }, randomUUID());

    const draft = await reworkService.createDraft(initiator(), {
      styleNo: "STYLE-LEGACY-DRAFT-AUDIT",
    }, randomUUID());
    const stored = await database.query<{
      source_receiving_batch_id: string;
      audited_receiving_batch_id: string;
    }>(
      `SELECT orders.source_receiving_batch_id,
              event.after_state->>'receivingBatchId' audited_receiving_batch_id
       FROM rework_orders orders
       JOIN operation_events event
         ON event.entity_type='rework_order'
        AND event.entity_id=orders.rework_order_id::text
        AND event.action='rework.draft.create'
       WHERE orders.rework_order_id=$1`,
      [draft.value.reworkOrderId],
    );
    expect(stored.rows[0]).toEqual({
      source_receiving_batch_id: receipt.value.receivingBatchId,
      audited_receiving_batch_id: receipt.value.receivingBatchId,
    });
  });

  it("records the resolved batch when an unbound server draft first receives its style", async () => {
    const image = await readyImage();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-DRAFT-UPDATE-AUDIT",
      documentQuantity: 18,
      actualQuantity: 18,
      attachmentIds: [image],
    }, randomUUID());

    const draft = await reworkService.createDraft(initiator(), {}, randomUUID());
    expect(draft.value.styleNo).toBeNull();

    await reworkService.updateDraft(initiator(), draft.value.reworkOrderId, {
      expectedVersion: draft.value.version,
      styleNo: "STYLE-DRAFT-UPDATE-AUDIT",
    }, randomUUID());

    const stored = await database.query<{
      source_receiving_batch_id: string;
      audited_receiving_batch_id: string;
    }>(
      `SELECT orders.source_receiving_batch_id,
              event.after_state->>'receivingBatchId' audited_receiving_batch_id
       FROM rework_orders orders
       JOIN operation_events event
         ON event.entity_type='rework_order'
        AND event.entity_id=orders.rework_order_id::text
        AND event.action='rework.draft.update'
       WHERE orders.rework_order_id=$1`,
      [draft.value.reworkOrderId],
    );
    expect(stored.rows[0]).toEqual({
      source_receiving_batch_id: receipt.value.receivingBatchId,
      audited_receiving_batch_id: receipt.value.receivingBatchId,
    });
  });

  it("searches known style numbers without forcing a second manual spelling", async () => {
    const options = await service.listStyleOptions("RECEIVING");
    expect(options).toContain("STYLE-RECEIVING-01");
  });
});
