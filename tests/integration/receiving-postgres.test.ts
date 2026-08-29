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

const pastBusinessDate = (days: number): string => {
  const [year, month, day] = businessDate().split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! - days)).toISOString().slice(0, 10);
};

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

  const insertReceiptAt = async (
    receivingBatchId: string,
    styleNo: string,
    documentQuantity: number,
    actualQuantity: number,
    defectiveQuantity: number,
    receivedAt: string,
  ): Promise<void> => {
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
        [eventId, requestId, receiverId, receiptId, JSON.stringify({ receiptId, receivingBatchId })],
      );
      await client.query(
        "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
        [eventId, requestId],
      );
      await client.query(
        `INSERT INTO receiving_receipts(
           receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,
           defective_quantity,received_by,received_at,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$9,$10)`,
        [
          receiptId,
          receivingBatchId,
          styleNo,
          documentQuantity,
          actualQuantity,
          defectiveQuantity,
          receiverId,
          receivedAt,
          eventId,
          requestId,
        ],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
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
    await migration("0095_receiving_defective_quantity.sql");
    await migration("0099_optional_tail_inspection.sql");
    await migration("0111_receiving_delivery_note_total.sql");
    await migration("0112_receiving_root_merge_image_replacement.sql");
    await migration("0113_tail_inspection_cost_bearer.sql");
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
      defective_quantity: number;
      difference_quantity: number;
      receiving_batch_id: string;
    }>(
      `SELECT document_quantity,actual_quantity,defective_quantity,difference_quantity,receiving_batch_id
       FROM receiving_receipts WHERE style_no='STYLE-LEGACY-01'`,
    );
    expect(legacy.rows[0]).toMatchObject({
      document_quantity: 50,
      actual_quantity: 45,
      defective_quantity: 0,
      difference_quantity: -5,
    });
    expect(legacy.rows[0]?.receiving_batch_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("keeps one delivery-note total while accumulating immutable same-style receipt facts", async () => {
    await expect(service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      attachmentIds: [],
    }, randomUUID())).rejects.toThrow("送货单图片必传");

    const firstImage = await readyImage();
    const firstKey = randomUUID();
    const first = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      defectiveQuantity: 5,
      attachmentIds: [firstImage],
    }, firstKey);
    expect(first.reused).toBe(false);
    expect(first.value).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 80,
      defectiveQuantity: 5,
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
      defectiveQuantity: 5,
      attachmentIds: [firstImage],
    }, firstKey);
    expect(replay.reused).toBe(true);

    const second = await service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 20,
      defectiveQuantity: 2,
      attachmentIds: [],
    }, randomUUID());
    expect(second.value.receivingBatchId).toBe(first.value.receivingBatchId);
    expect(second.value.differenceQuantity).toBe(-80);

    const board = await service.board(businessDate());
    const row = board.rows.find((item) => item.receivingBatchId === first.value.receivingBatchId);
    expect(row).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      attachments: [{ attachmentId: firstImage, filename: `${firstImage}.jpg` }],
      actualQuantity: 100,
      defectiveQuantity: 7,
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

    await expect(service.create(receiver(), {
      styleNo: "STYLE-INVALID-DEFECTIVE",
      documentQuantity: 2,
      actualQuantity: 1,
      defectiveQuantity: 2,
      attachmentIds: [],
    }, randomUUID())).rejects.toThrow("次品数量不能超过实际收货数量");

    const facts = await database.query<{ document_quantity: number; difference_quantity: number; defective_quantity: number }>(
      "SELECT document_quantity,difference_quantity,defective_quantity FROM receiving_receipts WHERE receiving_batch_id=$1 ORDER BY received_at,receipt_id",
      [first.value.receivingBatchId],
    );
    expect(facts.rows.map((item) => item.document_quantity)).toEqual([100, 100]);
    expect(facts.rows.map((item) => item.difference_quantity).sort((left, right) => left - right)).toEqual([-80, -20]);
    expect(facts.rows.map((item) => item.defective_quantity).sort((left, right) => left - right)).toEqual([2, 5]);
    await expect(database.query(
      "UPDATE receiving_receipts SET actual_quantity=100 WHERE receipt_id=$1",
      [first.value.receiptId],
    )).rejects.toThrow();
  });

  it("separates prior and in-range receipts while keeping the cumulative delivery-note difference", async () => {
    const today = businessDate();
    const yesterday = pastBusinessDate(1);
    const current = await service.create(receiver(), {
      styleNo: "STYLE-RANGE-01",
      documentQuantity: 100,
      actualQuantity: 30,
      defectiveQuantity: 1,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    await insertReceiptAt(
      current.value.receivingBatchId,
      "STYLE-RANGE-01",
      100,
      40,
      2,
      `${yesterday}T12:00:00+08:00`,
    );

    const todayOnly = await service.board(today);
    expect(todayOnly.rows.find((row) => row.receivingBatchId === current.value.receivingBatchId)).toMatchObject({
      documentQuantity: 100,
      priorActualQuantity: 40,
      actualQuantity: 30,
      defectiveQuantity: 1,
      differenceQuantity: -30,
      receiptCount: 2,
    });
    expect(todayOnly.kpis.receivedQuantity).toBeGreaterThanOrEqual(30);

    const twoDays = await service.board(yesterday, today, "STYLE-RANGE-01");
    expect(twoDays.rows).toHaveLength(1);
    expect(twoDays.rows[0]).toMatchObject({
      priorActualQuantity: 0,
      actualQuantity: 70,
      defectiveQuantity: 3,
      differenceQuantity: -30,
      receiptCount: 2,
    });
    expect(twoDays.kpis.receivedQuantity).toBe(70);
  });

  it("consolidates repeated style batches before status filtering and KPI calculation", async () => {
    const today = businessDate();
    const yesterday = pastBusinessDate(1);
    const current = await service.create(receiver(), {
      styleNo: "in20546664",
      documentQuantity: 4017,
      actualQuantity: 2040,
      defectiveQuantity: 0,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const backfilled = await service.create(receiver(), {
      styleNo: "in20546664",
      documentQuantity: 4017,
      actualQuantity: 1618,
      defectiveQuantity: 0,
      attachmentIds: [await readyImage()],
      receivedDate: yesterday,
    }, randomUUID());
    expect(current.value.styleNo).toBe("IN20546664");
    expect(backfilled.value.styleNo).toBe("IN20546664");
    expect(backfilled.value.receivingBatchId).not.toBe(current.value.receivingBatchId);

    const todayOnly = await service.board(today, today);
    const todayRow = todayOnly.rows.find((row) => row.styleNo === "IN20546664");
    expect(todayRow).toMatchObject({
      documentQuantity: 4017,
      priorActualQuantity: 1618,
      actualQuantity: 2040,
      cumulativeActualQuantity: 3658,
      differenceQuantity: -359,
      receiptCount: 2,
      batchCount: 2,
      rootMutable: false,
    });

    const allTimeSearch = await service.board(today, today, "in20546664");
    expect(allTimeSearch).toMatchObject({
      mode: "search",
      status: "all",
      kpis: {
        orderCount: 1,
        receivedQuantity: 3658,
        abnormalOrderCount: 1,
        differenceQuantity: 359,
        differenceRate: 8.94,
      },
    });
    expect(allTimeSearch.rows).toHaveLength(1);
    expect(allTimeSearch.rows[0]).toMatchObject({
      styleNo: "IN20546664",
      documentQuantity: 4017,
      actualQuantity: 3658,
      cumulativeActualQuantity: 3658,
      differenceQuantity: -359,
      receiptCount: 2,
      batchCount: 2,
    });

    const shortOnly = await service.board(today, today, "in20546664", "short");
    expect(shortOnly.rows).toHaveLength(1);
    expect(shortOnly.kpis).toEqual(allTimeSearch.kpis);
    const normalOnly = await service.board(today, today, "in20546664", "normal");
    expect(normalOnly.rows).toHaveLength(0);
    expect(normalOnly.kpis).toEqual({
      orderCount: 0,
      receivedQuantity: 0,
      abnormalOrderCount: 0,
      differenceQuantity: 0,
      differenceRate: 0,
    });
    await expect(service.board(today, today, "in20546664", "unknown"))
      .rejects.toThrow("收货状态筛选无效");
  });

  it("assigns Root quantity corrections to the audited correction date instead of prior receipts", async () => {
    const today = businessDate();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-RANGE-CORRECTION-01",
      documentQuantity: 100,
      actualQuantity: 100,
      defectiveQuantity: 4,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const before = (await service.board(today)).rows.find(
      (row) => row.receivingBatchId === receipt.value.receivingBatchId,
    )!;

    await service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: before.version,
      styleNo: before.styleNo,
      documentQuantity: before.documentQuantity,
      actualQuantity: 50,
      defectiveQuantity: 2,
    });

    const corrected = (await service.board(today)).rows.find(
      (row) => row.receivingBatchId === receipt.value.receivingBatchId,
    );
    expect(corrected).toMatchObject({
      priorActualQuantity: 0,
      actualQuantity: 50,
      defectiveQuantity: 2,
      differenceQuantity: -50,
    });
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
      defectiveQuantity: 2,
      attachmentIds: [image],
    }, randomUUID());

    let board = await service.board(businessDate());
    const before = board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)!;
    expect(before).toMatchObject({ defectiveQuantity: 2, version: 1, rootMutable: true });

    await expect(service.correctBatch(receiver(), receipt.value.receivingBatchId, {
      expectedVersion: before.version,
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
      defectiveQuantity: 1,
    })).rejects.toThrow("只有Root");

    const corrected = await service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: before.version,
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
      defectiveQuantity: 1,
    });
    expect(corrected).toMatchObject({
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
      defectiveQuantity: 1,
      differenceQuantity: -1,
      version: 2,
    });

    const immutableFact = await database.query<{
      style_no: string;
      document_quantity: number;
      actual_quantity: number;
      defective_quantity: number;
    }>(
      "SELECT style_no,document_quantity,actual_quantity,defective_quantity FROM receiving_receipts WHERE receipt_id=$1",
      [receipt.value.receiptId],
    );
    expect(immutableFact.rows[0]).toEqual({
      style_no: "STYLE-ROOT-CORRECT-01",
      document_quantity: 30,
      actual_quantity: 27,
      defective_quantity: 2,
    });

    board = await service.board(businessDate(), "CORRECTED");
    expect(board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)).toMatchObject({
      styleNo: "STYLE-ROOT-CORRECTED-01",
      documentQuantity: 32,
      actualQuantity: 31,
      defectiveQuantity: 1,
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

  it("keeps backfill facts in their own batch while consolidating the same style on the board", async () => {
    const current = await service.create(receiver(), {
      styleNo: "STYLE-BACKFILL-01",
      documentQuantity: 20,
      actualQuantity: 3,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const yesterday = pastBusinessDate(1);
    const backfilled = await service.create(receiver(), {
      styleNo: "STYLE-BACKFILL-01",
      documentQuantity: 20,
      actualQuantity: 17,
      attachmentIds: [await readyImage()],
      receivedDate: yesterday,
    }, randomUUID());

    expect(backfilled.value.receivingBatchId).not.toBe(current.value.receivingBatchId);
    const historicalBoard = await service.board(yesterday, yesterday);
    expect(historicalBoard.rows.find((row) => row.styleNo === "STYLE-BACKFILL-01")).toMatchObject({
      receivingBatchId: backfilled.value.receivingBatchId,
      styleNo: "STYLE-BACKFILL-01",
      documentQuantity: 20,
      actualQuantity: 17,
      cumulativeActualQuantity: 17,
      differenceQuantity: -3,
      receiptCount: 1,
    });

    const currentSearch = await service.board(businessDate(), businessDate(), "STYLE-BACKFILL-01");
    expect(currentSearch.rows).toHaveLength(1);
    expect(currentSearch.rows[0]?.receivingBatchId).toBe(current.value.receivingBatchId);
    expect(currentSearch.rows[0]).toMatchObject({
      documentQuantity: 20,
      actualQuantity: 20,
      cumulativeActualQuantity: 20,
      differenceQuantity: 0,
      receiptCount: 2,
      batchCount: 2,
    });

    const stored = await database.query<{
      received_date: string;
      audited_date: string;
      backfilled: boolean;
    }>(
      `SELECT (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date::text received_date,
              event.after_state->>'receivedDate' audited_date,
              (event.after_state->>'backfilled')::boolean backfilled
       FROM receiving_receipts receipt
       JOIN operation_events event ON event.event_id=receipt.operation_event_id
       WHERE receipt.receipt_id=$1`,
      [backfilled.value.receiptId],
    );
    expect(stored.rows[0]).toEqual({ received_date: yesterday, audited_date: yesterday, backfilled: true });

    const isolatedBackfill = await service.create(receiver(), {
      styleNo: "STYLE-BACKFILL-ISOLATED",
      documentQuantity: 15,
      actualQuantity: 7,
      attachmentIds: [await readyImage()],
      receivedDate: yesterday,
    }, randomUUID());
    const laterNormalReceipt = await service.create(receiver(), {
      styleNo: "STYLE-BACKFILL-ISOLATED",
      documentQuantity: 15,
      actualQuantity: 8,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    expect(laterNormalReceipt.value.receivingBatchId).not.toBe(isolatedBackfill.value.receivingBatchId);

    await expect(service.create(receiver(), {
      styleNo: "STYLE-BACKFILL-TOO-OLD",
      documentQuantity: 1,
      actualQuantity: 1,
      attachmentIds: [],
      receivedDate: pastBusinessDate(3),
    }, randomUUID())).rejects.toThrow("仅支持昨天和前天");
  });

  it("lets Root merge a typo style into the existing pre-rework batch without rewriting receipt facts", async () => {
    const targetImage = await readyImage();
    const sourceImage = await readyImage();
    const target = await service.create(receiver(), {
      styleNo: "STYLE-MERGE-CANONICAL",
      documentQuantity: 100,
      actualQuantity: 60,
      defectiveQuantity: 2,
      attachmentIds: [targetImage],
    }, randomUUID());
    const source = await service.create(receiver(), {
      styleNo: "STYLE-MERGE-TYPO",
      documentQuantity: 100,
      actualQuantity: 35,
      defectiveQuantity: 1,
      attachmentIds: [sourceImage],
    }, randomUUID());

    const sourceRow = (await service.board(businessDate(), businessDate(), "STYLE-MERGE-TYPO")).rows[0]!;
    const merged = await service.correctBatch(rootCorrector(), source.value.receivingBatchId, {
      expectedVersion: sourceRow.version,
      styleNo: "STYLE-MERGE-CANONICAL",
      documentQuantity: sourceRow.documentQuantity,
      actualQuantity: 30,
      defectiveQuantity: 0,
    });

    expect(merged).toMatchObject({
      receivingBatchId: target.value.receivingBatchId,
      styleNo: "STYLE-MERGE-CANONICAL",
      documentQuantity: 100,
      actualQuantity: 90,
      defectiveQuantity: 2,
      differenceQuantity: -10,
    });
    const board = await service.board(businessDate(), businessDate(), "STYLE-MERGE-CANONICAL");
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      receivingBatchId: target.value.receivingBatchId,
      documentQuantity: 100,
      actualQuantity: 90,
      defectiveQuantity: 2,
      currentActualQuantity: 90,
      currentDefectiveQuantity: 2,
      differenceQuantity: -10,
      receiptCount: 2,
    });
    expect(board.rows[0]?.attachments.map((item) => item.attachmentId).sort()).toEqual(
      [targetImage, sourceImage].sort(),
    );

    const facts = await database.query<{ receiving_batch_id: string; style_no: string }>(
      `SELECT receiving_batch_id,style_no FROM receiving_receipts
       WHERE receipt_id=ANY($1::uuid[]) ORDER BY receipt_id`,
      [[target.value.receiptId, source.value.receiptId]],
    );
    expect(facts.rows).toHaveLength(2);
    expect(facts.rows.every((row) => row.receiving_batch_id === target.value.receivingBatchId)).toBe(true);
    expect(facts.rows.map((row) => row.style_no).sort()).toEqual(
      ["STYLE-MERGE-CANONICAL", "STYLE-MERGE-TYPO"].sort(),
    );
    const sourceBatch = await database.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM receiving_batches WHERE receiving_batch_id=$1",
      [source.value.receivingBatchId],
    );
    expect(sourceBatch.rows[0]?.deleted_at).toBeInstanceOf(Date);
    const mergeAudit = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM operation_events
       WHERE action='receiving.batch.merge' AND entity_id=$1`,
      [target.value.receivingBatchId],
    );
    expect(mergeAudit.rows[0]?.count).toBe("1");
  });

  it("lets Root replace receiving images while retaining retired objects and audit", async () => {
    const original = await readyImage();
    const receipt = await service.create(receiver(), {
      styleNo: "STYLE-IMAGE-REPLACE",
      documentQuantity: 20,
      actualQuantity: 20,
      attachmentIds: [original],
    }, randomUUID());
    const before = (await service.board(businessDate(), businessDate(), "STYLE-IMAGE-REPLACE")).rows[0]!;
    const replacements = [await readyImage(), await readyImage()];

    await service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: before.version,
      styleNo: before.styleNo,
      documentQuantity: before.documentQuantity,
      actualQuantity: before.currentActualQuantity,
      defectiveQuantity: before.currentDefectiveQuantity,
      attachmentIds: replacements,
    });

    const after = (await service.board(businessDate(), businessDate(), "STYLE-IMAGE-REPLACE")).rows[0]!;
    expect(after.attachments.map((item) => item.attachmentId).sort()).toEqual(replacements.sort());
    const retained = await database.query<{ status: string; retired: boolean }>(
      `SELECT attachment.status,(retirement.attachment_id IS NOT NULL) AS retired
       FROM attachments attachment
       LEFT JOIN receiving_attachment_retirements retirement
         ON retirement.attachment_id=attachment.attachment_id
       WHERE attachment.attachment_id=$1`,
      [original],
    );
    expect(retained.rows[0]).toEqual({ status: "ready", retired: true });
    const audit = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM operation_events
       WHERE action='receiving.batch.images.replace' AND entity_id=$1`,
      [receipt.value.receivingBatchId],
    );
    expect(audit.rows[0]?.count).toBe("1");

    await expect(database.query(
      "DELETE FROM receiving_attachment_retirements WHERE attachment_id=$1",
      [original],
    )).rejects.toThrow();
  });

  it("searches known style numbers without forcing a second manual spelling", async () => {
    const options = await service.listStyleOptions("RECEIVING");
    expect(options).toContain("STYLE-RECEIVING-01");
  });
});
