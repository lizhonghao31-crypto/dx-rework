import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import "./receiving-analysis-postgres.cases.js";
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
  const schema = ownedPostgresSchema("receiving");
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const service = new ReceivingService(database, undefined, undefined, undefined, { allowLegacyStyleInput: true });
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

  const packingRecorder = (): TrustedActorContext => ({
    actorId: receiverId,
    actorRoles: ["warehouse_receiver"],
    authorizationCapability: "receiving:packing_manage",
    authorizationCapabilities: ["receiving:packing_manage"],
    requestId: randomUUID(),
  });

  const differenceResolver = (): TrustedActorContext => ({
    actorId: receiverId,
    actorRoles: ["order_merchandiser"],
    authorizationCapability: "receiving:resolve_difference",
    authorizationCapabilities: ["receiving:resolve_difference"],
    requestId: randomUUID(),
  });

  const migration = async (name: string): Promise<void> => {
    await database.query(await readFile(
      new URL(`../../apps/api/migrations/${name}`, import.meta.url),
      "utf8",
    ));
  };

  const insertLegacyReceipt = async (styleNo = "STYLE-LEGACY-01"): Promise<string> => {
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
         ) VALUES($1,$2,50,45,$3,$4,$5)`,
        [receiptId, styleNo, receiverId, eventId, requestId],
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
      const current = await client.query<{ version: number }>(
        "SELECT version FROM rework_orders WHERE rework_order_id=$1 FOR UPDATE",
        [reworkOrderId],
      );
      const nextVersion = (current.rows[0]?.version ?? 0) + 1;
      await client.query(
        `INSERT INTO operation_events(
           event_id,request_id,actor_id,actor_roles,authorization_capability,
           action,entity_type,entity_id,after_state,reason
         ) VALUES($1,$2,$3,ARRAY['quality_control'],'rework:initiate',
                  'rework.cancel','rework_order',$4,$5::jsonb,$6)`,
        [eventId, requestId, receiverId, reworkOrderId, JSON.stringify(draftAfterState(reworkOrderId, styleNo, "cancelled", nextVersion, reason)), reason],
      );
      await client.query(
        "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
        [eventId, requestId],
      );
      await client.query(
        `UPDATE rework_orders
         SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,
             cancel_reason=$3,updated_by=$2,version=$4,updated_at=clock_timestamp()
         WHERE rework_order_id=$1`,
        [reworkOrderId, receiverId, reason, nextVersion],
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
    await createOwnedPostgresSchema(admin, schema);
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
    await insertLegacyReceipt(" style-legacy-case-01 ");
    await migration("0086_receiving_rework_evidence_link.sql");
    await migration("0088_root_receiving_correction.sql");
    await migration("0095_receiving_defective_quantity.sql");
    await migration("0099_optional_tail_inspection.sql");
    await migration("0111_receiving_delivery_note_total.sql");
    await migration("0112_receiving_root_merge_image_replacement.sql");
    await migration("0113_tail_inspection_cost_bearer.sql");
    await migration("0115_receiving_style_identity_canonicalization.sql");
    await migration("0119_tail_inspection_cost_bearer_provenance.sql");
    await migration("0130_root_receiving_correction_after_rework.sql");
    await migration("0132_receiving_merge_into_rework_target.sql");
    await migration("0137_receiving_source_classification.sql");
    await migration("0138_receiving_receipt_corrections.sql");
    await migration("0139_receiving_packing_difference_resolution.sql");
    await migration("0140_receiving_packing_difference_direction.sql");
    await migration("0169_receiving_difference_evidence.sql");
    await migration("0190_receiving_difference_authority.sql");
    // This deliberately partial fixture tests receiving, not the QC state
    // machine. Match the additive write columns used by the current initiator;
    // the dedicated other-craft suite exercises all real 0227 guards.
    await database.query("ALTER TABLE rework_orders ADD COLUMN special_process_type text, ADD COLUMN other_craft_description text");
    // PR04 board reads the latest schema's optional cutting identity. This partial-migration
    // fixture stays intentionally legacy, so add only the nullable projection surface it needs.
    await database.query("ALTER TABLE receiving_batches ADD COLUMN cutting_order_id uuid");
    await database.query(`CREATE TABLE current_cutting_records(
      cutting_order_id uuid,
      actual_cut_count bigint,
      recorded_by uuid,
      recorded_at timestamptz
    )`);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','corp',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),receiverId,`test-${receiverId}`]);
    for(const role of ["warehouse_receiver","order_merchandiser"]) await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'receiving fixture')",[randomUUID(),receiverId,role]);
    await database.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','corp')");
  });

  afterAll(async () => {
    await database.end();
    await releaseOwnedPostgresSchema(admin, schema);
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

  it("opens rework from a canonical board row backed by a legacy cased batch", async () => {
    const board = await service.board(businessDate(), businessDate(), "style-legacy-case-01");
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      styleNo: "STYLE-LEGACY-CASE-01",
      documentQuantity: 50,
      actualQuantity: 45,
      differenceQuantity: -5,
    });

    const draft = await reworkService.createDraft(initiator(), {
      receivingBatchId: board.rows[0]!.receivingBatchId,
      styleNo: board.rows[0]!.styleNo,
    }, randomUUID());
    expect(draft.value.styleNo).toBe("STYLE-LEGACY-CASE-01");
    const stored = await database.query<{ source_receiving_batch_id: string }>(
      "SELECT source_receiving_batch_id FROM rework_orders WHERE rework_order_id=$1",
      [draft.value.reworkOrderId],
    );
    expect(stored.rows[0]?.source_receiving_batch_id).toBe(board.rows[0]!.receivingBatchId);
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

    await expect(service.create(receiver(), {
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 100,
      actualQuantity: 20,
      defectiveQuantity: 2,
      attachmentIds: [],
    }, randomUUID())).rejects.toThrow("请到“多次收货”录入");

    const jiashun = await service.createRepeated(receiver(), {
      receivingBatchId: first.value.receivingBatchId,
      source: "jiashun",
      actualQuantity: 20,
      defectiveQuantity: 2,
    }, randomUUID());
    expect(jiashun.value.receivingBatchId).toBe(first.value.receivingBatchId);
    expect(jiashun.value.differenceQuantity).toBe(-80);

    await expect(service.createRepeated(receiver(), {
      receivingBatchId: first.value.receivingBatchId,
      source: "other_factory",
      actualQuantity: 30,
      defectiveQuantity: 1,
    }, randomUUID())).rejects.toThrow("本次送货单数量");

    const otherFactory = await service.createRepeated(receiver(), {
      receivingBatchId: first.value.receivingBatchId,
      source: "other_factory",
      documentQuantity: 30,
      actualQuantity: 30,
      defectiveQuantity: 1,
    }, randomUUID());
    expect(otherFactory.value.receivingBatchId).toBe(first.value.receivingBatchId);
    expect(otherFactory.value.differenceQuantity).toBe(0);

    const board = await service.board(businessDate());
    const row = board.rows.find((item) => item.receivingBatchId === first.value.receivingBatchId);
    expect(row).toMatchObject({
      styleNo: "STYLE-RECEIVING-01",
      documentQuantity: 130,
      attachments: [{ attachmentId: firstImage, filename: `${firstImage}.jpg` }],
      actualQuantity: 130,
      defectiveQuantity: 8,
      differenceQuantity: 0,
      receiptCount: 3,
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

    const facts = await database.query<{ document_quantity: number; difference_quantity: number; defective_quantity: number; receiving_source: string }>(
      "SELECT document_quantity,difference_quantity,defective_quantity,receiving_source FROM receiving_receipts WHERE receiving_batch_id=$1 ORDER BY received_at,receipt_id",
      [first.value.receivingBatchId],
    );
    expect(facts.rows.map((item) => item.document_quantity).sort((left, right) => left - right)).toEqual([100, 100, 30].sort((left, right) => left - right));
    expect(facts.rows.map((item) => item.difference_quantity).sort((left, right) => left - right)).toEqual([-80, -20, 0]);
    expect(facts.rows.map((item) => item.defective_quantity).sort((left, right) => left - right)).toEqual([1, 2, 5]);
    expect(facts.rows.map((item) => item.receiving_source).sort()).toEqual(["initial", "jiashun", "other_factory"].sort());
    const batch = await database.query<{ delivery_note_quantity: string }>(
      "SELECT delivery_note_quantity FROM receiving_batches WHERE receiving_batch_id=$1",
      [first.value.receivingBatchId],
    );
    expect(batch.rows[0]?.delivery_note_quantity).toBe("130");
    await expect(database.query(
      "UPDATE receiving_receipts SET actual_quantity=100 WHERE receipt_id=$1",
      [first.value.receiptId],
    )).rejects.toThrow();
  });

  it("lets Root correct one historical receipt without rewriting receipt facts", async () => {
    const initial = await service.create(receiver(), {
      styleNo: "STYLE-RECEIPT-CORRECTION-01",
      documentQuantity: 100,
      actualQuantity: 80,
      defectiveQuantity: 5,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const repeated = await service.createRepeated(receiver(), {
      receivingBatchId: initial.value.receivingBatchId,
      source: "jiashun",
      actualQuantity: 20,
      defectiveQuantity: 2,
    }, randomUUID());
    const before = (await service.board(businessDate(), businessDate(), "STYLE-RECEIPT-CORRECTION-01")).rows[0]!;
    const corrected = await service.correctReceipt(rootCorrector(), repeated.value.receiptId, {
      expectedVersion: before.version,
      source: "other_factory",
      documentQuantity: 30,
      actualQuantity: 25,
      defectiveQuantity: 3,
    });
    expect(corrected).toMatchObject({
      receivingBatchId: initial.value.receivingBatchId,
      documentQuantity: 130,
      actualQuantity: 105,
      defectiveQuantity: 8,
      differenceQuantity: -25,
    });
    const board = await service.board(businessDate(), businessDate(), "STYLE-RECEIPT-CORRECTION-01");
    expect(board.rows[0]).toMatchObject({
      documentQuantity: 130,
      currentActualQuantity: 105,
      currentDefectiveQuantity: 8,
      differenceQuantity: -25,
    });
    expect(board.rows[0]?.receivingHistory.find((item) => item.receiptId === repeated.value.receiptId)).toMatchObject({
      receivingSource: "other_factory",
      receiptDocumentQuantity: 30,
      actualQuantity: 25,
      defectiveQuantity: 3,
    });
    const original = await database.query<{
      receiving_source: string;
      document_quantity: string;
      actual_quantity: string;
      defective_quantity: string;
    }>(
      `SELECT receiving_source,document_quantity::text,actual_quantity::text,defective_quantity::text
       FROM receiving_receipts WHERE receipt_id=$1`,
      [repeated.value.receiptId],
    );
    expect(original.rows[0]).toEqual({
      receiving_source: "jiashun",
      document_quantity: "100",
      actual_quantity: "20",
      defective_quantity: "2",
    });
    const correction = await database.query<{
      receiving_source: string;
      document_quantity: string;
      actual_quantity: string;
      defective_quantity: string;
    }>(
      `SELECT receiving_source,document_quantity::text,actual_quantity::text,defective_quantity::text
       FROM receiving_receipt_corrections WHERE receipt_id=$1`,
      [repeated.value.receiptId],
    );
    expect(correction.rows[0]).toEqual({
      receiving_source: "other_factory",
      document_quantity: "30",
      actual_quantity: "25",
      defective_quantity: "3",
    });
    await expect(database.query(
      "UPDATE receiving_receipt_corrections SET actual_quantity=1 WHERE receipt_id=$1",
      [repeated.value.receiptId],
    )).rejects.toThrow("immutable");
  });

  it("replaces the base delivery note and keeps later corrections out of earlier board ranges", async () => {
    const yesterday = pastBusinessDate(1);
    const initial = await service.create(receiver(), {
      styleNo: "STYLE-BASE-RECEIPT-CORRECTION",
      documentQuantity: 100,
      actualQuantity: 80,
      defectiveQuantity: 5,
      attachmentIds: [await readyImage()],
      receivedDate: yesterday,
    }, randomUUID());
    const currentBefore = (await service.board(
      businessDate(),
      businessDate(),
      "STYLE-BASE-RECEIPT-CORRECTION",
    )).rows[0]!;

    const corrected = await service.correctReceipt(rootCorrector(), initial.value.receiptId, {
      expectedVersion: currentBefore.version,
      source: "other_factory",
      documentQuantity: 120,
      actualQuantity: 90,
      defectiveQuantity: 6,
    });
    expect(corrected).toMatchObject({
      documentQuantity: 120,
      actualQuantity: 90,
      defectiveQuantity: 6,
      differenceQuantity: -30,
    });

    const current = (await service.board(
      businessDate(),
      businessDate(),
      "STYLE-BASE-RECEIPT-CORRECTION",
    )).rows[0]!;
    expect(current).toMatchObject({
      documentQuantity: 120,
      currentActualQuantity: 90,
      currentDefectiveQuantity: 6,
      cumulativeGoodQuantity: 84,
      differenceQuantity: -30,
    });
    expect(current.receivingHistory[0]).toMatchObject({
      receivingSource: "other_factory",
      receiptDocumentQuantity: 120,
      actualQuantity: 90,
      defectiveQuantity: 6,
    });

    const historical = (await service.board(yesterday, yesterday)).rows
      .find((row) => row.styleNo === "STYLE-BASE-RECEIPT-CORRECTION")!;
    expect(historical).toMatchObject({
      documentQuantity: 100,
      actualQuantity: 80,
      cumulativeActualQuantity: 80,
      cumulativeGoodQuantity: 75,
      differenceQuantity: -20,
    });
    expect(historical.receivingHistory[0]).toMatchObject({
      receivingSource: "backfill",
      receiptDocumentQuantity: 100,
      actualQuantity: 80,
      defectiveQuantity: 5,
      cumulativeActualQuantity: 80,
    });
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
      cumulativeGoodQuantity: 67,
      differenceQuantity: -30,
      receiptCount: 2,
    });
    expect(todayOnly.kpis.receivedQuantity).toBeGreaterThanOrEqual(30);
    const historical = (await service.board(yesterday, yesterday)).rows
      .find(row => row.receivingBatchId === current.value.receivingBatchId)!;
    expect(historical).toMatchObject({cumulativeActualQuantity:40,cumulativeGoodQuantity:38,differenceQuantity:-60});

    const twoDays = await service.board(yesterday, today, "STYLE-RANGE-01");
    expect(twoDays.rows).toHaveLength(1);
    expect(twoDays.rows[0]).toMatchObject({
      priorActualQuantity: 0,
      actualQuantity: 70,
      defectiveQuantity: 3,
      cumulativeGoodQuantity: 67,
      differenceQuantity: -30,
      receiptCount: 2,
    });
    expect(twoDays.kpis.receivedQuantity).toBe(70);
    const searched = await service.board(today, today, "STYLE-RANGE-01");
    expect(searched.rows[0]).toMatchObject({cumulativeActualQuantity:70,cumulativeGoodQuantity:67,differenceQuantity:-30});
    expect(searched.kpis.receivedQuantity).toBe(70);
    expect(twoDays).toMatchObject({ page: 1, pageSize: 15, totalCount: 1, totalPages: 1 });

    const literalWildcard = await service.board(today, today, "%");
    expect(literalWildcard.rows).toHaveLength(0);
    expect(literalWildcard.kpis.orderCount).toBe(0);
  });

  it("keeps a genuine zero good-piece count when all received pieces are defective",async()=>{
    await service.create(receiver(),{styleNo:"STYLE-ALL-DEFECTIVE",documentQuantity:10,actualQuantity:10,defectiveQuantity:10,attachmentIds:[await readyImage()]},randomUUID());
    const board=await service.board(businessDate(),businessDate(),"STYLE-ALL-DEFECTIVE");
    expect(board.rows[0]).toMatchObject({cumulativeActualQuantity:10,cumulativeGoodQuantity:0,defectiveQuantity:10,differenceQuantity:0});
    expect(board.kpis).toMatchObject({receivedQuantity:10,abnormalOrderCount:0,differenceQuantity:0,differenceRate:0});
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
    expect(allTimeSearch.rows[0]?.receivingHistory).toHaveLength(2);
    expect(allTimeSearch.rows[0]?.receivingHistory).toMatchObject([
      {
        sequence: 2,
        documentQuantity: 4017,
        actualQuantity: 2040,
        cumulativeActualQuantity: 3658,
        differenceQuantity: -359,
      },
      {
        sequence: 1,
        documentQuantity: 4017,
        actualQuantity: 1618,
        cumulativeActualQuantity: 1618,
        differenceQuantity: -2399,
      },
    ]);
    expect(Date.parse(allTimeSearch.rows[0]!.receivingHistory[0]!.receivedAt)).not.toBeNaN();
    expect(allTimeSearch.rows[0]!.receivingHistory[0]!.receiverName).toBeTruthy();

    await service.create(receiver(), {
      styleNo: "AB546664ZZ",
      documentQuantity: 10,
      actualQuantity: 10,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const repeatOptions = await service.listRepeatOptions("546664");
    expect(repeatOptions).toEqual([{
      receivingBatchId: current.value.receivingBatchId,
      styleNo: "IN20546664",
      documentQuantity: 4017,
    }]);

    const shortOnly = await service.board(today, today, "in20546664", "short");
    expect(shortOnly.rows).toHaveLength(1);
    expect(shortOnly.kpis).toEqual(allTimeSearch.kpis);
    const multipleOnly = await service.board(today, today, "in20546664", "multiple");
    expect(multipleOnly.rows).toHaveLength(1);
    expect(multipleOnly.rows[0]?.receiptCount).toBe(2);
    expect(multipleOnly.kpis).toEqual(allTimeSearch.kpis);
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

    const repeatKey = randomUUID();
    const repeated = await service.createRepeated(receiver(), {
      receivingBatchId: current.value.receivingBatchId,
      source: "jiashun",
      actualQuantity: 100,
      defectiveQuantity: 2,
    }, repeatKey);
    const replayed = await service.createRepeated(receiver(), {
      receivingBatchId: current.value.receivingBatchId,
      source: "jiashun",
      actualQuantity: 100,
      defectiveQuantity: 2,
    }, repeatKey);
    expect(replayed.reused).toBe(true);
    expect(replayed.value.receiptId).toBe(repeated.value.receiptId);
    expect(repeated.value).toMatchObject({
      receivingBatchId: current.value.receivingBatchId,
      styleNo: "IN20546664",
      documentQuantity: 4017,
      actualQuantity: 100,
      defectiveQuantity: 2,
    });
    const otherFactory = await service.createRepeated(receiver(), {
      receivingBatchId: current.value.receivingBatchId,
      source: "other_factory",
      documentQuantity: 200,
      actualQuantity: 200,
      defectiveQuantity: 0,
    }, randomUUID());
    expect(otherFactory.value).toMatchObject({
      documentQuantity: 200,
      actualQuantity: 200,
      differenceQuantity: 0,
    });
    const afterRepeat = await service.board(today, today, "in20546664");
    expect(afterRepeat.rows[0]).toMatchObject({
      documentQuantity: 4217,
      cumulativeActualQuantity: 3958,
      differenceQuantity: -259,
      receiptCount: 4,
    });
    await expect(service.createRepeated(receiver(), {
      receivingBatchId: backfilled.value.receivingBatchId,
      source: "jiashun",
      actualQuantity: 1,
      defectiveQuantity: 0,
    }, randomUUID())).rejects.toThrow("该订单已不可追加收货，请重新搜索选择");
  });

  it.each(["receiving", "packing"] as const)("binds %s evidence to the resolution and preserves its immutable history", async (differenceType) => {
    const created = await service.create(receiver(), {
      styleNo: `TEST-EVIDENCE-${differenceType}`, documentQuantity: 100, actualQuantity: 90,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    let row = (await service.board(businessDate(), `TEST-EVIDENCE-${differenceType}`)).rows[0]!;
    if (differenceType === "packing") {
      await service.recordPacking(packingRecorder(), {
        receivingBatchId: created.value.receivingBatchId, expectedVersion: row.version,
        expectedPackingRevisionId: null, packingQuantity: 85,
      }, randomUUID());
      row = (await service.board(businessDate(), `TEST-EVIDENCE-${differenceType}`)).rows[0]!;
    }
    const attachmentIds = differenceType === "receiving"
      ? [await readyImage()] : [await readyImage("image/png"), await readyImage("image/webp")];
    const input = {
      receivingBatchId: row.receivingBatchId, expectedVersion: row.version,
      expectedDocumentQuantity: row.documentQuantity, expectedActualQuantity: row.cumulativeActualQuantity,
      expectedPackingRevisionId: row.packingRevisionId, differenceType, result: "已核对并留存处理图片", attachmentIds,
    };
    const actor = differenceResolver();
    const key = randomUUID();
    const resolved = await service.resolveDifference(actor, input, key);
    const replay = await service.resolveDifference(actor, input, key);
    expect(replay.reused).toBe(true);
    expect(replay.value.resolutionId).toBe(resolved.value.resolutionId);
    expect(resolved.value.handledBy).toBe(actor.actorId);
    const after = (await service.board(businessDate(), row.styleNo)).rows[0]!;
    const record = differenceType === "receiving" ? after.receivingDifferenceResolution! : after.packingDifferenceResolution!;
    expect(record.attachments.map((image) => image.attachmentId).sort()).toEqual([...attachmentIds].sort());
    expect(record.handledBy).toBe("仓管测试");
    expect(record.handledAt).toBe(resolved.value.handledAt);
    expect(after.attachments).toHaveLength(1);
    expect(after.attachments.some((image) => attachmentIds.includes(image.attachmentId))).toBe(false);
    for (const sql of [
      "UPDATE attachments SET entity_id='other-record' WHERE attachment_id=$1",
      "UPDATE attachments SET original_filename='changed.jpg' WHERE attachment_id=$1",
      "DELETE FROM attachments WHERE attachment_id=$1",
    ]) await expect(database.query(sql, [attachmentIds[0]])).rejects.toThrow(/immutable/);
    await service.createRepeated(receiver(), {
      receivingBatchId: row.receivingBatchId, source: "jiashun", actualQuantity: 1,
    }, randomUUID());
    const changed = (await service.board(businessDate(), row.styleNo)).rows[0]!;
    expect(differenceType === "receiving" ? changed.receivingDifferenceResolution : changed.packingDifferenceResolution).toBeNull();
    const history = await database.query("SELECT entity_id FROM attachments WHERE attachment_id=ANY($1::uuid[])", [attachmentIds]);
    expect(history.rows.every((image) => image.entity_id === resolved.value.resolutionId)).toBe(true);
  });

  it("filters the original board by pending, handled and stale snapshots without counting missing packing as zero", async () => {
    const styleNo = "B-PR05-FILTER";
    const created = await service.create(receiver(), {styleNo, documentQuantity: 100, actualQuantity: 90, attachmentIds: [await readyImage()]}, randomUUID());
    const query = (status = "all") => service.board(businessDate(), businessDate(), styleNo, status);
    const initial = await query("missing_packing");
    expect(initial.totalCount).toBe(1); expect(initial.rows[0]!.packingDifferenceQuantity).toBeNull();
    expect(initial.insights).toEqual({pendingCount: 1, missingPackingCount: 1, staleCount: 0});
    const row = initial.rows[0]!;
    const resolved = await service.resolveDifference(differenceResolver(), {receivingBatchId: created.value.receivingBatchId,
      expectedVersion: row.version, expectedDocumentQuantity: 100, expectedActualQuantity: 90,
      differenceType: "receiving", result: "下一批补回"}, randomUUID());
    expect((await query("pending")).totalCount).toBe(0);
    expect((await query("handled")).rows[0]!.receivingDifferenceResolution?.resolutionId).toBe(resolved.value.resolutionId);
    await service.createRepeated(receiver(), {receivingBatchId: row.receivingBatchId, source: "jiashun", actualQuantity: 5}, randomUUID());
    const stale = await query("stale");
    expect(stale.totalCount).toBe(1); expect(stale.insights).toEqual({pendingCount: 1, missingPackingCount: 1, staleCount: 1});
    expect(stale.rows[0]).toMatchObject({differenceQuantity: -5, receivingDifferenceResolution: null, staleResolution: true});
    expect(stale.rows[0]!.resolutionHistory[0]).toMatchObject({resolutionId: resolved.value.resolutionId, differenceQuantity: -10, result: "下一批补回"});
    expect((await query("packing_difference")).totalCount).toBe(0);
    expect((await query("receiving_difference")).kpis.orderCount).toBe(1);
  });

  it("rejects invalid evidence atomically without saving a false handled result", async () => {
    const deliveryImage = await readyImage();
    const created = await service.create(receiver(), {
      styleNo: "TEST-EVIDENCE-REJECTIONS", documentQuantity: 100, actualQuantity: 90, attachmentIds: [deliveryImage],
    }, randomUUID());
    const row = (await service.board(businessDate(), "TEST-EVIDENCE-REJECTIONS")).rows[0]!;
    const input = {
      receivingBatchId: created.value.receivingBatchId, expectedVersion: row.version,
      expectedDocumentQuantity: 100, expectedActualQuantity: 90,
      differenceType: "receiving" as const, result: "不可保存的不完整证据",
    };
    const good = await readyImage();
    const pdf = await readyImage("application/pdf");
    const pending = await readyImage();
    await database.query("UPDATE attachments SET status='pending',ready_at=NULL WHERE attachment_id=$1", [pending]);
    const otherOwner = randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'其他上传人',true)", [otherOwner]);
    const foreign = await readyImage();
    await database.query("UPDATE attachments SET uploaded_by=$2 WHERE attachment_id=$1", [foreign, otherOwner]);
    for (const [attachmentIds, message] of [
      [[good, pdf], "仅支持"], [[good, pending], "尚未上传完成"],
      [[good, foreign], "本人"], [[good, deliveryImage], "已绑定"],
      [[good, randomUUID()], "不存在"], [[good, good], "不能重复"],
      [["not-a-uuid"], "标识无效"], [[good, pdf, pending, foreign], "最多3张"],
    ] as const) {
      await expect(service.resolveDifference(differenceResolver(), { ...input, attachmentIds }, randomUUID())).rejects.toThrow(message);
      expect((await service.board(businessDate(), row.styleNo)).rows[0]!.receivingDifferenceResolution).toBeNull();
      expect((await database.query("SELECT entity_type FROM attachments WHERE attachment_id=$1", [good])).rows[0]!.entity_type).toBeNull();
    }
    await expect(service.resolveDifference(packingRecorder(), { ...input, attachmentIds: [good] }, randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    expect((await database.query("SELECT count(*)::int AS count FROM receiving_difference_resolutions WHERE receiving_batch_id=$1", [row.receivingBatchId])).rows[0]!.count).toBe(0);
  });

  it("records cumulative packing and resolves both live differences with immutable audit", async () => {
    const created = await service.create(receiver(), {
      styleNo: "STYLE-BOARD-OPERATIONS-01",
      documentQuantity: 1_944,
      actualQuantity: 1_736,
      defectiveQuantity: 0,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const initial = (await service.board(
      businessDate(), businessDate(), "STYLE-BOARD-OPERATIONS-01",
    )).rows[0]!;

    const packingKey = randomUUID();
    const packingInput = {
      receivingBatchId: created.value.receivingBatchId,
      expectedVersion: initial.version,
      expectedPackingRevisionId: null,
      packingQuantity: 1_700,
    };
    const packing = await service.recordPacking(packingRecorder(), packingInput, packingKey);
    const packingReplay = await service.recordPacking(packingRecorder(), packingInput, packingKey);
    expect(packingReplay.reused).toBe(true);
    expect(packingReplay.value.packingRevisionId).toBe(packing.value.packingRevisionId);

    const afterPacking = (await service.board(
      businessDate(), businessDate(), "STYLE-BOARD-OPERATIONS-01",
    )).rows[0]!;
    expect(afterPacking).toMatchObject({
      packingQuantity: 1_700,
      packingDifferenceQuantity: -36,
      receivingDifferenceResolution: null,
      packingDifferenceResolution: null,
    });

    await service.resolveDifference(differenceResolver(), {
      receivingBatchId: afterPacking.receivingBatchId,
      expectedVersion: afterPacking.version,
      expectedDocumentQuantity: afterPacking.documentQuantity,
      expectedActualQuantity: afterPacking.cumulativeActualQuantity,
      expectedPackingRevisionId: afterPacking.packingRevisionId,
      differenceType: "receiving",
      result: "已与送货工厂核对，差额转下一批补回",
    }, randomUUID());
    await service.resolveDifference(differenceResolver(), {
      receivingBatchId: afterPacking.receivingBatchId,
      expectedVersion: afterPacking.version,
      expectedDocumentQuantity: afterPacking.documentQuantity,
      expectedActualQuantity: afterPacking.cumulativeActualQuantity,
      expectedPackingRevisionId: afterPacking.packingRevisionId,
      differenceType: "packing",
      result: "尾部复核完成，装箱差异为-36件",
    }, randomUUID());

    const resolved = (await service.board(
      businessDate(), businessDate(), "STYLE-BOARD-OPERATIONS-01",
    )).rows[0]!;
    expect(resolved.receivingDifferenceResolution).toMatchObject({
      result: "已与送货工厂核对，差额转下一批补回",
      handledBy: "仓管测试",
    });
    expect(resolved.packingDifferenceResolution).toMatchObject({
      result: "尾部复核完成，装箱差异为-36件",
      handledBy: "仓管测试",
    });

    await expect(database.query(
      "UPDATE receiving_packing_revisions SET packing_quantity=1701 WHERE packing_revision_id=$1",
      [packing.value.packingRevisionId],
    )).rejects.toThrow("receiving board operation history is immutable");

    await service.createRepeated(receiver(), {
      receivingBatchId: created.value.receivingBatchId,
      source: "jiashun",
      actualQuantity: 6,
      defectiveQuantity: 0,
    }, randomUUID());
    const changed = (await service.board(
      businessDate(), businessDate(), "STYLE-BOARD-OPERATIONS-01",
    )).rows[0]!;
    expect(changed).toMatchObject({
      cumulativeActualQuantity: 1_742,
      receivingDifferenceResolution: null,
      packingDifferenceResolution: null,
    });
    await expect(service.resolveDifference(differenceResolver(), {
      receivingBatchId: changed.receivingBatchId,
      expectedVersion: changed.version,
      expectedDocumentQuantity: 1_944,
      expectedActualQuantity: 1_736,
      expectedPackingRevisionId: changed.packingRevisionId,
      differenceType: "receiving",
      result: "旧数量不可继续提交",
    }, randomUUID())).rejects.toThrow("订单数量已变化");
  });

  it.each([
    { styleNo: "STYLE-PACKING-DIRECTION-SHORT", packingQuantity: 90, expectedDifference: -10 },
    { styleNo: "STYLE-PACKING-DIRECTION-EXTRA", packingQuantity: 110, expectedDifference: 10 },
  ])("calculates $packingQuantity packed against 100 received as $expectedDifference", async ({
    styleNo,
    packingQuantity,
    expectedDifference,
  }) => {
    const created = await service.create(receiver(), {
      styleNo,
      documentQuantity: 100,
      actualQuantity: 100,
      defectiveQuantity: 0,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const initial = (await service.board(businessDate(), businessDate(), styleNo)).rows[0]!;
    await service.recordPacking(packingRecorder(), {
      receivingBatchId: created.value.receivingBatchId,
      expectedVersion: initial.version,
      expectedPackingRevisionId: null,
      packingQuantity,
    }, randomUUID());

    expect((await service.board(businessDate(), businessDate(), styleNo)).rows[0])
      .toMatchObject({ cumulativeActualQuantity: 100, packingQuantity, packingDifferenceQuantity: expectedDifference });
  });

  it("keeps an open rework action visible when same-style receiving batches consolidate", async () => {
    const today = businessDate();
    const yesterday = pastBusinessDate(1);
    const current = await service.create(receiver(), {
      styleNo: "STYLE-REWORK-PROJECTION-01",
      documentQuantity: 100,
      actualQuantity: 30,
      attachmentIds: [await readyImage()],
    }, randomUUID());
    const historical = await service.create(receiver(), {
      styleNo: "STYLE-REWORK-PROJECTION-01",
      documentQuantity: 100,
      actualQuantity: 40,
      attachmentIds: [await readyImage()],
      receivedDate: yesterday,
    }, randomUUID());
    expect(historical.value.receivingBatchId).not.toBe(current.value.receivingBatchId);

    const draft = await reworkService.createDraft(initiator(), {
      receivingBatchId: historical.value.receivingBatchId,
      styleNo: "STYLE-REWORK-PROJECTION-01",
    }, randomUUID());

    const board = await service.board(today, today, "STYLE-REWORK-PROJECTION-01");
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      receivingBatchId: current.value.receivingBatchId,
      batchCount: 2,
      reworkOrderId: draft.value.reworkOrderId,
      reworkStatus: "draft",
    });

    await cancelReworkDraft(draft.value.reworkOrderId, "STYLE-REWORK-PROJECTION-01");
    const afterCancellation = await service.board(today, today, "STYLE-REWORK-PROJECTION-01");
    expect(afterCancellation.rows[0]).toMatchObject({
      receivingBatchId: current.value.receivingBatchId,
      reworkOrderId: null,
      reworkStatus: null,
    });
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

  it("lets Root correct style and quantities after rework starts while receipt facts and deletion lock remain intact", async () => {
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

    const activeRow = board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)!;
    const corrected = await service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: activeRow.version,
      styleNo: "STYLE-REWORK-LINK-CORRECTED-01",
      documentQuantity: 44,
      actualQuantity: 39,
      defectiveQuantity: 3,
    });
    expect(corrected).toMatchObject({
      receivingBatchId: receipt.value.receivingBatchId,
      styleNo: "STYLE-REWORK-LINK-CORRECTED-01",
      documentQuantity: 44,
      actualQuantity: 39,
      defectiveQuantity: 3,
      differenceQuantity: -5,
      version: 2,
    });
    const correctedFacts = await database.query<{
      batch_style: string;
      receipt_style: string;
      document_quantity: number;
      actual_quantity: number;
      defective_quantity: number;
      rework_style: string;
      rework_version: number;
    }>(
      `SELECT batch.style_no AS batch_style,receipt.style_no AS receipt_style,
              receipt.document_quantity,receipt.actual_quantity,receipt.defective_quantity,
              rework.style_no AS rework_style,rework.version AS rework_version
       FROM receiving_batches batch
       JOIN receiving_receipts receipt USING(receiving_batch_id)
       JOIN rework_orders rework ON rework.source_receiving_batch_id=batch.receiving_batch_id
       WHERE batch.receiving_batch_id=$1 AND rework.rework_order_id=$2`,
      [receipt.value.receivingBatchId, firstDraftId],
    );
    expect(correctedFacts.rows[0]).toEqual({
      batch_style: "STYLE-REWORK-LINK-CORRECTED-01",
      receipt_style: "STYLE-REWORK-LINK-01",
      document_quantity: 40,
      actual_quantity: 40,
      defective_quantity: 0,
      rework_style: "STYLE-REWORK-LINK-CORRECTED-01",
      rework_version: 2,
    });
    board = await service.board(businessDate(), businessDate(), "STYLE-REWORK-LINK-CORRECTED-01");
    expect(board.rows[0]).toMatchObject({
      receivingBatchId: receipt.value.receivingBatchId,
      documentQuantity: 44,
      actualQuantity: 39,
      defectiveQuantity: 3,
      rootCorrectable: true,
      rootDeletable: false,
      rootMutable: false,
    });

    await expect(service.correctBatch(rootCorrector(), receipt.value.receivingBatchId, {
      expectedVersion: corrected.version,
      styleNo: corrected.styleNo,
      documentQuantity: corrected.documentQuantity,
      actualQuantity: corrected.actualQuantity,
      defectiveQuantity: corrected.defectiveQuantity,
      attachmentIds: [await readyImage()],
    })).rejects.toThrow("返工发起后不能替换送货单图片");

    await cancelReworkDraft(firstDraftId, "STYLE-REWORK-LINK-CORRECTED-01");
    board = await service.board(businessDate(), businessDate(), "STYLE-REWORK-LINK-CORRECTED-01");
    const cancelledRow = board.rows.find((item) => item.receivingBatchId === receipt.value.receivingBatchId)!;
    expect(cancelledRow.reworkStatus).toBeNull();
    expect(cancelledRow.rootMutable).toBe(false);
    await expect(service.deleteBatch(rootCorrector(), receipt.value.receivingBatchId, cancelledRow.version))
      .rejects.toThrow("已经发起过返工");

    const secondDraftId = await createReworkDraft("STYLE-REWORK-LINK-CORRECTED-01");
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

  it("keeps same-style cutting tasks as separate board rows with their own cutting facts", async () => {
    const styleNo = "STYLE-CUTTING-BOARD-GROUP";
    const firstBatchId = randomUUID();
    const secondBatchId = randomUUID();
    const firstCuttingOrderId = randomUUID();
    const secondCuttingOrderId = randomUUID();
    await database.query(
      `INSERT INTO receiving_batches(
         receiving_batch_id,style_no,cutting_order_id,created_by,created_at,delivery_note_quantity
       ) VALUES($1,$3,$4,$5,CURRENT_TIMESTAMP,50),
               ($2,$3,$6,$5,CURRENT_TIMESTAMP - interval '1 day',50)`,
      [
        firstBatchId,
        secondBatchId,
        styleNo,
        firstCuttingOrderId,
        receiverId,
        secondCuttingOrderId,
      ],
    );
    await insertReceiptAt(
      firstBatchId,
      styleNo,
      50,
      40,
      0,
      new Date().toISOString(),
    );
    await insertReceiptAt(
      secondBatchId,
      styleNo,
      50,
      30,
      0,
      new Date(Date.now() - 86400000).toISOString(),
    );
    await database.query(
      `INSERT INTO current_cutting_records(
         cutting_order_id,actual_cut_count,recorded_by,recorded_at
       ) VALUES($1,50,$3,CURRENT_TIMESTAMP),($2,51,$3,CURRENT_TIMESTAMP)`,
      [firstCuttingOrderId, secondCuttingOrderId, receiverId],
    );

    const board = await service.board(businessDate(), businessDate(), styleNo);
    expect(board.rows).toHaveLength(2);
    expect(board.rows.map((row) => row.receivingBatchId).sort()).toEqual(
      [firstBatchId, secondBatchId].sort(),
    );
    expect(board.rows.map((row) => row.actualCutCount).sort((a, b) => (a ?? 0) - (b ?? 0)))
      .toEqual([50, 51]);
    expect(board.rows.every((row) => row.cuttingRecordedBy === "仓管测试")).toBe(true);
    expect(board.rows.every((row) => row.cuttingRecordedAt !== null)).toBe(true);
    expect(board.kpis.orderCount).toBe(2);
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
      cumulativeGoodQuantity: 88,
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

  it("lets Root merge a typo batch into a canonical batch that already has rework and reconcile quantities", async () => {
    const targetImage = await readyImage();
    const sourceImage = await readyImage();
    const target = await service.create(receiver(), {
      styleNo: "IN20541804",
      documentQuantity: 1976,
      actualQuantity: 100,
      defectiveQuantity: 2,
      attachmentIds: [targetImage],
    }, randomUUID());
    const reworkDraft = await reworkService.createDraft(initiator(), {
      receivingBatchId: target.value.receivingBatchId,
      styleNo: "IN20541804",
    }, randomUUID());
    const reworkOrderId = reworkDraft.value.reworkOrderId;
    const source = await service.create(receiver(), {
      styleNo: "LN20541804",
      documentQuantity: 1976,
      actualQuantity: 150,
      defectiveQuantity: 1,
      attachmentIds: [sourceImage],
    }, randomUUID());

    const sourceRow = (await service.board(businessDate(), businessDate(), "LN20541804")).rows[0]!;
    await expect(service.correctBatch(rootCorrector(), source.value.receivingBatchId, {
      expectedVersion: sourceRow.version,
      styleNo: "IN20541804",
      documentQuantity: 1976,
      actualQuantity: 147,
      defectiveQuantity: 0,
      attachmentIds: [await readyImage()],
    })).rejects.toThrow("目标订单已经发起过返工，不能替换送货单图片");
    const merged = await service.correctBatch(rootCorrector(), source.value.receivingBatchId, {
      expectedVersion: sourceRow.version,
      styleNo: "IN20541804",
      documentQuantity: 1976,
      actualQuantity: 147,
      defectiveQuantity: 0,
    });

    expect(merged).toMatchObject({
      receivingBatchId: target.value.receivingBatchId,
      styleNo: "IN20541804",
      documentQuantity: 1976,
      actualQuantity: 247,
      defectiveQuantity: 2,
      differenceQuantity: -1729,
    });
    const board = await service.board(businessDate(), businessDate(), "IN20541804");
    expect(board.rows).toHaveLength(1);
    expect(board.rows[0]).toMatchObject({
      receivingBatchId: target.value.receivingBatchId,
      actualQuantity: 247,
      currentActualQuantity: 247,
      defectiveQuantity: 2,
      currentDefectiveQuantity: 2,
      receiptCount: 2,
      reworkOrderId,
      reworkStatus: "draft",
      rootCorrectable: true,
      rootDeletable: false,
    });
    expect(board.rows[0]?.attachments.map((item) => item.attachmentId).sort()).toEqual(
      [targetImage, sourceImage].sort(),
    );
    const link = await database.query<{ source_receiving_batch_id: string; style_no: string }>(
      "SELECT source_receiving_batch_id,style_no FROM rework_orders WHERE rework_order_id=$1",
      [reworkOrderId],
    );
    expect(link.rows[0]).toEqual({
      source_receiving_batch_id: target.value.receivingBatchId,
      style_no: "IN20541804",
    });
    const sourceBatch = await database.query<{ deleted_at: Date | null }>(
      "SELECT deleted_at FROM receiving_batches WHERE receiving_batch_id=$1",
      [source.value.receivingBatchId],
    );
    expect(sourceBatch.rows[0]?.deleted_at).toBeInstanceOf(Date);
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
