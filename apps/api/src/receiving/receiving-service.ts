import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

const MAX_RECEIVING_IMAGES = 3;
const RECEIVING_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CreateReceivingInput = Readonly<{
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  attachmentIds?: readonly string[];
}>;

type ReceivingReceipt = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receivedBy: string;
  receivedAt: string;
}>;

type ReworkStatus = "draft" | "active" | "completed" | null;

type BoardRow = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  differenceQuantity: number;
  receiptCount: number;
  lastReceivedAt: string;
  lastReceiverName: string;
  reworkOrderId: string | null;
  reworkStatus: ReworkStatus;
}>;

type BoardResult = Readonly<{
  date: string;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    abnormalOrderCount: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
}>;

type Result<T> = Readonly<{ value: T; reused: boolean }>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

const fail = (message: string, status = 400, code = "VALIDATION_ERROR"): never => {
  throw new ApplicationError(code, message, status);
};

const normalizeStyleNo = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 100) fail("款号不能为空且不能超过100个字符");
  return normalized;
};

const validateQuantity = (value: number, label: string, allowZero: boolean): number => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 10_000_000) {
    fail(`${label}必须是${allowZero ? "大于等于0" : "大于0"}的整数`);
  }
  return value;
};

const normalizeAttachmentIds = (values: readonly string[] | undefined): readonly string[] => {
  const attachmentIds = values ?? [];
  if (attachmentIds.length > MAX_RECEIVING_IMAGES) fail("收货单图片最多3张");
  if (new Set(attachmentIds).size !== attachmentIds.length) fail("收货单图片不能重复");
  if (attachmentIds.some((value) => !UUID_PATTERN.test(value))) fail("收货单图片标识无效");
  return attachmentIds;
};

const lifecycle = (status: string | null): ReworkStatus => {
  if (!status || status === "cancelled" || status === "deleted") return null;
  if (status === "draft") return "draft";
  if (status === "completed") return "completed";
  return "active";
};

export class ReceivingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  async create(
    actor: TrustedActorContext,
    input: CreateReceivingInput,
    idempotencyKey: string,
  ): Promise<Result<ReceivingReceipt>> {
    const normalized = {
      styleNo: normalizeStyleNo(input.styleNo),
      documentQuantity: validateQuantity(input.documentQuantity, "收货单数量", false),
      actualQuantity: validateQuantity(input.actualQuantity, "实际收货数量", true),
      attachmentIds: normalizeAttachmentIds(input.attachmentIds),
    };
    const scope = "receiving.receipt.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, normalized),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode: 201, response: await this.createInTransaction(client, actor, normalized) }));
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveReceivingBatch(
    client: PoolClient,
    actor: TrustedActorContext,
    styleNo: string,
  ): Promise<{ receivingBatchId: string; isNew: boolean }> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [styleNo]);
    const latest = await client.query<{ receiving_batch_id: string; closed: boolean }>(
      `SELECT batch.receiving_batch_id,
              EXISTS(
                SELECT 1 FROM rework_orders rework
                WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
                  AND rework.status='completed'
              ) AS closed
       FROM receiving_batches batch
       WHERE batch.style_no=$1
       ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
       LIMIT 1`,
      [styleNo],
    );
    const current = latest.rows[0];
    if (current && !current.closed) return { receivingBatchId: current.receiving_batch_id, isNew: false };

    const receivingBatchId = randomUUID();
    await client.query(
      `INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by)
       VALUES($1,$2,$3)`,
      [receivingBatchId, styleNo, actor.actorId],
    );
    return { receivingBatchId, isNew: true };
  }

  private async bindReceivingImages(
    client: PoolClient,
    actor: TrustedActorContext,
    receivingBatchId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const existing = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM attachments
       WHERE entity_type='receiving_batch' AND entity_id=$1 AND status='ready'`,
      [receivingBatchId],
    );
    const existingCount = Number(existing.rows[0]?.count ?? 0);

    if (attachmentIds.length === 0) {
      if (existingCount === 0) fail("收货单图片必传，最多3张");
      return;
    }

    const candidates = await client.query<{
      attachment_id: string;
      uploaded_by: string;
      mime_type: string;
      status: string;
      entity_type: string | null;
      entity_id: string | null;
    }>(
      `SELECT attachment_id,uploaded_by,mime_type,status,entity_type,entity_id
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
       FOR UPDATE`,
      [attachmentIds],
    );
    if (candidates.rows.length !== attachmentIds.length) fail("收货单图片不存在或不可用");

    let newBindings = 0;
    for (const row of candidates.rows) {
      if (row.status !== "ready") fail("收货单图片尚未上传完成");
      if (row.uploaded_by !== actor.actorId) fail("只能使用本人上传的收货单图片", 403, "FORBIDDEN");
      if (!RECEIVING_IMAGE_MIME_TYPES.has(row.mime_type)) fail("收货单图片仅支持JPEG、PNG、WebP");
      const alreadyBound = row.entity_type === "receiving_batch" && row.entity_id === receivingBatchId;
      if (row.entity_type !== null && !alreadyBound) fail("收货单图片已绑定到其他业务记录", 409, "CONFLICT");
      if (!alreadyBound) newBindings += 1;
    }
    if (existingCount + newBindings > MAX_RECEIVING_IMAGES) fail("收货单图片最多3张");

    await client.query(
      `UPDATE attachments
       SET entity_type='receiving_batch',entity_id=$2
       WHERE attachment_id=ANY($1::uuid[])
         AND entity_type IS NULL`,
      [attachmentIds, receivingBatchId],
    );
  }

  private async createInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    input: Required<CreateReceivingInput>,
  ): Promise<ReceivingReceipt> {
    const { receivingBatchId } = await this.resolveReceivingBatch(client, actor, input.styleNo);
    await this.bindReceivingImages(client, actor, receivingBatchId, input.attachmentIds);

    const receiptId = randomUUID();
    const eventId = await this.events.append(client, actor, {
      action: "receiving.receipt.create",
      entityType: "receiving_receipt",
      entityId: receiptId,
      after: {
        receiptId,
        receivingBatchId,
        styleNo: input.styleNo,
        documentQuantity: input.documentQuantity,
        actualQuantity: input.actualQuantity,
        differenceQuantity: input.actualQuantity - input.documentQuantity,
        attachmentIds: input.attachmentIds,
      },
    });
    await client.query(
      "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    const inserted = await client.query<{
      receipt_id: string;
      receiving_batch_id: string;
      style_no: string;
      document_quantity: number;
      actual_quantity: number;
      difference_quantity: number;
      received_by: string;
      received_at: Date;
    }>(
      `INSERT INTO receiving_receipts(
         receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,
         received_by,operation_event_id,request_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,
                 difference_quantity,received_by,received_at`,
      [
        receiptId,
        receivingBatchId,
        input.styleNo,
        input.documentQuantity,
        input.actualQuantity,
        actor.actorId,
        eventId,
        actor.requestId,
      ],
    );
    const row = inserted.rows[0]!;
    return {
      receiptId: row.receipt_id,
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: row.document_quantity,
      actualQuantity: row.actual_quantity,
      differenceQuantity: row.difference_quantity,
      receivedBy: row.received_by,
      receivedAt: row.received_at.toISOString(),
    };
  }

  async listStyleOptions(query = ""): Promise<readonly string[]> {
    const needle = query.trim();
    const result = await this.database.query<{ style_no: string }>(
      `SELECT source.style_no
       FROM (
         SELECT style_no FROM receiving_receipts
         UNION
         SELECT style_no FROM rework_orders WHERE style_no IS NOT NULL AND status<>'deleted'
       ) source
       WHERE ($1::text='' OR source.style_no ILIKE '%' || $1 || '%')
       ORDER BY source.style_no
       LIMIT 100`,
      [needle],
    );
    return result.rows.map((row) => row.style_no);
  }

  async board(date: string, query = ""): Promise<BoardResult> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail("日期格式必须为YYYY-MM-DD");
    const needle = query.trim();
    const rowsResult = await this.database.query<{
      receiving_batch_id: string;
      style_no: string;
      document_quantity: string;
      actual_quantity: string;
      difference_quantity: string;
      receipt_count: string;
      last_received_at: Date;
      last_receiver_name: string;
      rework_order_id: string | null;
      rework_status: string | null;
    }>(
      `WITH scoped_batches AS (
         SELECT DISTINCT receiving_batch_id
         FROM receiving_receipts
         WHERE (received_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date
           AND ($2::text='' OR style_no ILIKE '%' || $2 || '%')
       ), totals AS (
         SELECT r.receiving_batch_id,
                max(r.style_no) AS style_no,
                sum(r.document_quantity)::bigint AS document_quantity,
                sum(r.actual_quantity)::bigint AS actual_quantity,
                sum(r.difference_quantity)::bigint AS difference_quantity,
                count(*)::bigint AS receipt_count,
                max(r.received_at) AS last_received_at
         FROM receiving_receipts r
         JOIN scoped_batches scope ON scope.receiving_batch_id=r.receiving_batch_id
         WHERE (r.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date
         GROUP BY r.receiving_batch_id
       )
       SELECT totals.receiving_batch_id,totals.style_no,totals.document_quantity,
              totals.actual_quantity,totals.difference_quantity,totals.receipt_count,
              totals.last_received_at,receiver.display_name AS last_receiver_name,
              rework.rework_order_id,rework.status AS rework_status
       FROM totals
       JOIN LATERAL (
         SELECT u.display_name
         FROM receiving_receipts latest
         JOIN app_users u ON u.id=latest.received_by
         WHERE latest.receiving_batch_id=totals.receiving_batch_id
           AND (latest.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date
         ORDER BY latest.received_at DESC,latest.receipt_id DESC
         LIMIT 1
       ) receiver ON true
       LEFT JOIN LATERAL (
         SELECT item.rework_order_id,item.status
         FROM rework_orders item
         WHERE item.source_receiving_batch_id=totals.receiving_batch_id
           AND item.status<>'deleted'
         ORDER BY item.updated_at DESC,item.rework_order_id DESC
         LIMIT 1
       ) rework ON true
       ORDER BY CASE WHEN totals.difference_quantity<0 THEN 0 WHEN totals.difference_quantity>0 THEN 1 ELSE 2 END,
                abs(totals.difference_quantity) DESC,totals.last_received_at DESC,totals.style_no`,
      [date, needle],
    );
    const rows: BoardRow[] = rowsResult.rows.map((row) => ({
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
      actualQuantity: Number(row.actual_quantity),
      differenceQuantity: Number(row.difference_quantity),
      receiptCount: Number(row.receipt_count),
      lastReceivedAt: row.last_received_at.toISOString(),
      lastReceiverName: row.last_receiver_name,
      reworkOrderId: row.rework_order_id,
      reworkStatus: lifecycle(row.rework_status),
    }));
    const dayStats = await this.database.query<{ received_quantity: string }>(
      `SELECT COALESCE(sum(actual_quantity),0)::bigint AS received_quantity
       FROM receiving_receipts
       WHERE (received_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date
         AND ($2::text='' OR style_no ILIKE '%' || $2 || '%')`,
      [date, needle],
    );
    const differenceQuantity = rows.reduce((sum, row) => sum + Math.abs(row.differenceQuantity), 0);
    const abnormalOrderCount = rows.filter((row) => row.differenceQuantity !== 0).length;
    const documentQuantity = rows.reduce((sum, row) => sum + row.documentQuantity, 0);
    return {
      date,
      kpis: {
        orderCount: rows.length,
        receivedQuantity: Number(dayStats.rows[0]?.received_quantity ?? 0),
        abnormalOrderCount,
        differenceQuantity,
        differenceRate: documentQuantity === 0 ? 0 : Number(((differenceQuantity / documentQuantity) * 100).toFixed(2)),
      },
      rows,
    };
  }
}

export type { BoardResult, CreateReceivingInput, ReceivingReceipt };
