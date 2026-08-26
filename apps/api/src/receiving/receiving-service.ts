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
  defectiveQuantity?: number;
  attachmentIds?: readonly string[];
  receivedDate?: string;
}>;

type NormalizedCreateReceivingInput = Readonly<{
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  attachmentIds: readonly string[];
  receivedDate: string | null;
}>;

type CorrectReceivingBatchInput = Readonly<{
  expectedVersion: number;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity?: number;
}>;

type ReceivingReceipt = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  differenceQuantity: number;
  receivedBy: string;
  receivedAt: string;
}>;

type ReworkStatus = "draft" | "active" | "completed" | null;

type BoardRow = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  attachments: readonly Readonly<{ attachmentId: string; filename: string }>[];
  actualQuantity: number;
  defectiveQuantity: number;
  differenceQuantity: number;
  receiptCount: number;
  lastReceivedAt: string;
  lastReceiverName: string;
  reworkOrderId: string | null;
  reworkStatus: ReworkStatus;
  version: number;
  rootMutable: boolean;
}>;

type ReceivingBatchSnapshot = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  differenceQuantity: number;
  version: number;
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

const businessDate = (now: Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);

const shiftDate = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
};

const normalizeReceivingBackfillDate = (value: string | undefined, now = new Date()): string | null => {
  if (value === undefined) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail("补录日期无效");
  }
  const today = businessDate(now);
  if (value < shiftDate(today, -2) || value > shiftDate(today, -1)) {
    fail("补录仅支持昨天和前天；今天请使用普通收货");
  }
  return value;
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
    const actualQuantity = validateQuantity(input.actualQuantity, "实际收货数量", true);
    const defectiveQuantity = validateQuantity(input.defectiveQuantity ?? 0, "次品数量", true);
    if (defectiveQuantity > actualQuantity) fail("次品数量不能超过实际收货数量");
    const normalized = {
      styleNo: normalizeStyleNo(input.styleNo),
      documentQuantity: validateQuantity(input.documentQuantity, "收货单数量", false),
      actualQuantity,
      defectiveQuantity,
      attachmentIds: normalizeAttachmentIds(input.attachmentIds),
      receivedDate: normalizeReceivingBackfillDate(input.receivedDate),
    };
    const scope = "receiving.receipt.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, {
          styleNo: normalized.styleNo,
          documentQuantity: normalized.documentQuantity,
          actualQuantity: normalized.actualQuantity,
          defectiveQuantity: normalized.defectiveQuantity,
          attachmentIds: normalized.attachmentIds,
          ...(normalized.receivedDate ? { receivedDate: normalized.receivedDate } : {}),
        }),
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

  private assertRootCorrector(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "receiving:correct"
      || !actor.actorRoles.includes("root_superuser")
    ) {
      fail("只有Root可以修改或删除收货订单", 403, "FORBIDDEN");
    }
  }

  private validateExpectedVersion(value: number): number {
    if (!Number.isInteger(value) || value < 1) fail("收货订单版本无效");
    return value;
  }

  private async lockStyles(client: PoolClient, styles: readonly string[]): Promise<void> {
    for (const style of [...new Set(styles)].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [style]);
    }
  }

  private async mutableBatch(
    client: PoolClient,
    receivingBatchId: string,
  ): Promise<Readonly<{
    style_no: string;
    version: number;
    deleted_at: Date | null;
    document_quantity: string;
    actual_quantity: string;
    defective_quantity: string;
    has_rework_history: boolean;
  }>> {
    const result = await client.query<{
      style_no: string;
      version: number;
      deleted_at: Date | null;
      document_quantity: string;
      actual_quantity: string;
      defective_quantity: string;
      has_rework_history: boolean;
    }>(
      `SELECT batch.style_no,batch.version,batch.deleted_at,
              (totals.document_quantity+batch.document_quantity_adjustment)::bigint AS document_quantity,
              (totals.actual_quantity+batch.actual_quantity_adjustment)::bigint AS actual_quantity,
              (totals.defective_quantity+batch.defective_quantity_adjustment)::bigint AS defective_quantity,
              EXISTS(
                SELECT 1 FROM rework_orders rework
                WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
              ) AS has_rework_history
       FROM receiving_batches batch
       JOIN LATERAL (
         SELECT sum(receipt.document_quantity)::bigint AS document_quantity,
                sum(receipt.actual_quantity)::bigint AS actual_quantity,
                sum(receipt.defective_quantity)::bigint AS defective_quantity
         FROM receiving_receipts receipt
         WHERE receipt.receiving_batch_id=batch.receiving_batch_id
       ) totals ON totals.document_quantity IS NOT NULL
       WHERE batch.receiving_batch_id=$1
       FOR UPDATE OF batch`,
      [receivingBatchId],
    );
    const row = result.rows[0];
    if (!row) return fail("收货订单不存在", 404, "NOT_FOUND");
    if (row.deleted_at) return fail("收货订单不存在", 404, "NOT_FOUND");
    if (row.has_rework_history) {
      fail("该订单已经发起过返工，不能再修改或删除", 409, "INVALID_STATE_TRANSITION");
    }
    return row;
  }

  async correctBatch(
    actor: TrustedActorContext,
    receivingBatchId: string,
    input: CorrectReceivingBatchInput,
  ): Promise<ReceivingBatchSnapshot> {
    this.assertRootCorrector(actor);
    if (!UUID_PATTERN.test(receivingBatchId)) fail("收货订单标识无效");
    const normalized = {
      expectedVersion: this.validateExpectedVersion(input.expectedVersion),
      styleNo: normalizeStyleNo(input.styleNo),
      documentQuantity: validateQuantity(input.documentQuantity, "收货单数量", false),
      actualQuantity: validateQuantity(input.actualQuantity, "实际收货数量", true),
      defectiveQuantity: input.defectiveQuantity === undefined
        ? undefined
        : validateQuantity(input.defectiveQuantity, "次品数量", true),
    };
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const currentStyle = await client.query<{ style_no: string }>(
        "SELECT style_no FROM receiving_batches WHERE receiving_batch_id=$1",
        [receivingBatchId],
      );
      const styleRow = currentStyle.rows[0];
      if (!styleRow) return fail("收货订单不存在", 404, "NOT_FOUND");
      await this.lockStyles(client, [styleRow.style_no, normalized.styleNo]);
      const current = await this.mutableBatch(client, receivingBatchId);
      if (current.version !== normalized.expectedVersion) {
        fail("收货订单已被其他人修改，请刷新后重试", 409, "CONFLICT");
      }
      const defectiveQuantity = normalized.defectiveQuantity ?? Number(current.defective_quantity);
      if (defectiveQuantity > normalized.actualQuantity) fail("次品数量不能超过实际收货数量");
      const before = {
        receivingBatchId,
        styleNo: current.style_no,
        documentQuantity: Number(current.document_quantity),
        actualQuantity: Number(current.actual_quantity),
        defectiveQuantity: Number(current.defective_quantity),
        differenceQuantity: Number(current.actual_quantity) - Number(current.document_quantity),
        version: current.version,
      };
      const after: ReceivingBatchSnapshot = {
        receivingBatchId,
        styleNo: normalized.styleNo,
        documentQuantity: normalized.documentQuantity,
        actualQuantity: normalized.actualQuantity,
        defectiveQuantity,
        differenceQuantity: normalized.actualQuantity - normalized.documentQuantity,
        version: current.version + 1,
      };
      const eventId = await this.events.append(client, actor, {
        action: "receiving.batch.correct",
        entityType: "receiving_batch",
        entityId: receivingBatchId,
        before,
        after,
      });
      await client.query(
        "SELECT set_config('dx_rework.receiving_root_action','correct',true)",
      );
      const updated = await client.query(
        `UPDATE receiving_batches batch
         SET style_no=$2,
             document_quantity_adjustment=$3-(
               SELECT sum(receipt.document_quantity)
               FROM receiving_receipts receipt
               WHERE receipt.receiving_batch_id=batch.receiving_batch_id
             ),
             actual_quantity_adjustment=$4-(
               SELECT sum(receipt.actual_quantity)
               FROM receiving_receipts receipt
               WHERE receipt.receiving_batch_id=batch.receiving_batch_id
             ),
             defective_quantity_adjustment=$5-(
               SELECT sum(receipt.defective_quantity)
               FROM receiving_receipts receipt
               WHERE receipt.receiving_batch_id=batch.receiving_batch_id
             ),
             version=batch.version+1,updated_by=$6,updated_at=clock_timestamp(),
             last_operation_event_id=$7,last_request_id=$8
         WHERE batch.receiving_batch_id=$1
           AND batch.version=$9
           AND batch.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1 FROM rework_orders rework
             WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
           )`,
        [
          receivingBatchId,
          normalized.styleNo,
          normalized.documentQuantity,
          normalized.actualQuantity,
          defectiveQuantity,
          actor.actorId,
          eventId,
          actor.requestId,
          normalized.expectedVersion,
        ],
      );
      if (updated.rowCount !== 1) fail("收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteBatch(
    actor: TrustedActorContext,
    receivingBatchId: string,
    expectedVersion: number,
  ): Promise<Readonly<{ receivingBatchId: string; deleted: true }>> {
    this.assertRootCorrector(actor);
    if (!UUID_PATTERN.test(receivingBatchId)) fail("收货订单标识无效");
    const version = this.validateExpectedVersion(expectedVersion);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const currentStyle = await client.query<{ style_no: string }>(
        "SELECT style_no FROM receiving_batches WHERE receiving_batch_id=$1",
        [receivingBatchId],
      );
      const styleRow = currentStyle.rows[0];
      if (!styleRow) return fail("收货订单不存在", 404, "NOT_FOUND");
      await this.lockStyles(client, [styleRow.style_no]);
      const current = await this.mutableBatch(client, receivingBatchId);
      if (current.version !== version) fail("收货订单已被其他人修改，请刷新后重试", 409, "CONFLICT");
      const before = {
        receivingBatchId,
        styleNo: current.style_no,
        documentQuantity: Number(current.document_quantity),
        actualQuantity: Number(current.actual_quantity),
        defectiveQuantity: Number(current.defective_quantity),
        differenceQuantity: Number(current.actual_quantity) - Number(current.document_quantity),
        version: current.version,
      };
      const after = { ...before, version: current.version + 1, deleted: true as const };
      const eventId = await this.events.append(client, actor, {
        action: "receiving.batch.delete",
        entityType: "receiving_batch",
        entityId: receivingBatchId,
        before,
        after,
      });
      await client.query("SELECT set_config('dx_rework.receiving_root_action','delete',true)");
      const updated = await client.query(
        `UPDATE receiving_batches batch
         SET deleted_at=clock_timestamp(),deleted_by=$2,version=batch.version+1,
             updated_by=$2,updated_at=clock_timestamp(),
             last_operation_event_id=$3,last_request_id=$4
         WHERE batch.receiving_batch_id=$1
           AND batch.version=$5
           AND batch.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1 FROM rework_orders rework
             WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
           )`,
        [receivingBatchId, actor.actorId, eventId, actor.requestId, version],
      );
      if (updated.rowCount !== 1) fail("收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
      await client.query("COMMIT");
      return { receivingBatchId, deleted: true };
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
    receivedDate: string | null,
  ): Promise<{ receivingBatchId: string; isNew: boolean }> {
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [styleNo]);
    const latest = await client.query<{ receiving_batch_id: string; closed: boolean }>(
      `SELECT batch.receiving_batch_id,
              EXISTS(
                SELECT 1 FROM rework_orders rework
                WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
                  AND (
                    rework.status='completed'
                    OR EXISTS (
                      SELECT 1 FROM operation_events event
                      WHERE event.entity_type='rework_order'
                        AND event.entity_id=rework.rework_order_id::text
                        AND event.after_state->>'status'='completed'
                    )
                  )
              ) AS closed
       FROM receiving_batches batch
       WHERE batch.style_no=$1
         AND batch.deleted_at IS NULL
         AND NOT EXISTS(
           SELECT 1
           FROM receiving_receipts backfill_receipt
           JOIN operation_events backfill_event
             ON backfill_event.event_id=backfill_receipt.operation_event_id
           WHERE backfill_receipt.receiving_batch_id=batch.receiving_batch_id
             AND backfill_event.after_state->>'backfilled'='true'
         )
       ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
       LIMIT 1`,
      [styleNo],
    );
    const current = latest.rows[0];
    if (!receivedDate && current && !current.closed) return { receivingBatchId: current.receiving_batch_id, isNew: false };

    const receivingBatchId = randomUUID();
    await client.query(
      `INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,created_at)
       VALUES($1,$2,$3,COALESCE(
         ($4::date+(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
         CURRENT_TIMESTAMP
       ))`,
      [receivingBatchId, styleNo, actor.actorId, receivedDate],
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
    input: NormalizedCreateReceivingInput,
  ): Promise<ReceivingReceipt> {
    const { receivingBatchId } = await this.resolveReceivingBatch(client, actor, input.styleNo, input.receivedDate);
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
        defectiveQuantity: input.defectiveQuantity,
        differenceQuantity: input.actualQuantity - input.documentQuantity,
        attachmentIds: input.attachmentIds,
        ...(input.receivedDate ? { receivedDate: input.receivedDate, backfilled: true } : {}),
      },
    });
    await client.query(
      "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    await this.bindReceivingImages(client, actor, receivingBatchId, input.attachmentIds);

    const inserted = await client.query<{
      receipt_id: string;
      receiving_batch_id: string;
      style_no: string;
      document_quantity: number;
      actual_quantity: number;
      defective_quantity: number;
      difference_quantity: number;
      received_by: string;
      received_at: Date;
    }>(
      `INSERT INTO receiving_receipts(
         receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,defective_quantity,
         received_by,operation_event_id,request_id,received_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE(
         ($10::date+(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
         CURRENT_TIMESTAMP
       ))
       RETURNING receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,defective_quantity,
                 difference_quantity,received_by,received_at`,
      [
        receiptId,
        receivingBatchId,
        input.styleNo,
        input.documentQuantity,
        input.actualQuantity,
        input.defectiveQuantity,
        actor.actorId,
        eventId,
        actor.requestId,
        input.receivedDate,
      ],
    );
    const row = inserted.rows[0]!;
    return {
      receiptId: row.receipt_id,
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: row.document_quantity,
      actualQuantity: row.actual_quantity,
      defectiveQuantity: row.defective_quantity,
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
         SELECT style_no FROM receiving_batches WHERE deleted_at IS NULL
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
      receiving_attachments: { attachmentId: string; filename: string }[];
      actual_quantity: string;
      defective_quantity: string;
      difference_quantity: string;
      receipt_count: string;
      last_received_at: Date;
      last_receiver_name: string;
      rework_order_id: string | null;
      rework_status: string | null;
      version: number;
      root_mutable: boolean;
    }>(
      `WITH scoped_batches AS (
         SELECT DISTINCT receipt.receiving_batch_id
         FROM receiving_receipts receipt
         JOIN receiving_batches batch
           ON batch.receiving_batch_id=receipt.receiving_batch_id
          AND batch.deleted_at IS NULL
         WHERE ($2::text<>'' OR (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date=$1::date)
           AND ($2::text='' OR batch.style_no ILIKE '%' || $2 || '%')
       ), totals AS (
         SELECT r.receiving_batch_id,
                batch.style_no,
                (sum(r.document_quantity)+batch.document_quantity_adjustment)::bigint AS document_quantity,
                (sum(r.actual_quantity)+batch.actual_quantity_adjustment)::bigint AS actual_quantity,
                (sum(r.defective_quantity)+batch.defective_quantity_adjustment)::bigint AS defective_quantity,
                (sum(r.actual_quantity)+batch.actual_quantity_adjustment
                  -sum(r.document_quantity)-batch.document_quantity_adjustment)::bigint AS difference_quantity,
                count(*)::bigint AS receipt_count,
                max(r.received_at) AS last_received_at,
                batch.version
         FROM receiving_receipts r
         JOIN scoped_batches scope ON scope.receiving_batch_id=r.receiving_batch_id
         JOIN receiving_batches batch
           ON batch.receiving_batch_id=r.receiving_batch_id
          AND batch.deleted_at IS NULL
         WHERE ($2::text<>'' OR (r.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date)
         GROUP BY r.receiving_batch_id,batch.receiving_batch_id
       )
       SELECT totals.receiving_batch_id,totals.style_no,totals.document_quantity,
              totals.actual_quantity,totals.defective_quantity,totals.difference_quantity,totals.receipt_count,
              totals.last_received_at,receiver.display_name AS last_receiver_name,
              rework.rework_order_id,rework.status AS rework_status,
              COALESCE(receiving_attachments.items,'[]'::jsonb) AS receiving_attachments,
              totals.version,
              NOT EXISTS(
                SELECT 1 FROM rework_orders history
                WHERE history.source_receiving_batch_id=totals.receiving_batch_id
              ) AS root_mutable
       FROM totals
       JOIN LATERAL (
         SELECT u.display_name
         FROM receiving_receipts latest
         JOIN app_users u ON u.id=latest.received_by
         WHERE latest.receiving_batch_id=totals.receiving_batch_id
           AND ($2::text<>'' OR (latest.received_at AT TIME ZONE 'Asia/Shanghai')::date<=$1::date)
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
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'attachmentId',attachment.attachment_id,
                    'filename',attachment.original_filename
                  )
                  ORDER BY attachment.created_at,attachment.attachment_id
                ) AS items
         FROM attachments attachment
         WHERE attachment.entity_type='receiving_batch'
           AND attachment.entity_id=totals.receiving_batch_id::text
           AND attachment.status='ready'
           AND attachment.mime_type LIKE 'image/%'
       ) receiving_attachments ON true
       ORDER BY CASE WHEN totals.difference_quantity<0 THEN 0 WHEN totals.difference_quantity>0 THEN 1 ELSE 2 END,
                abs(totals.difference_quantity) DESC,totals.last_received_at DESC,totals.style_no`,
      [date, needle],
    );
    const rows: BoardRow[] = rowsResult.rows.map((row) => ({
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
      attachments: row.receiving_attachments,
      actualQuantity: Number(row.actual_quantity),
      defectiveQuantity: Number(row.defective_quantity),
      differenceQuantity: Number(row.difference_quantity),
      receiptCount: Number(row.receipt_count),
      lastReceivedAt: row.last_received_at.toISOString(),
      lastReceiverName: row.last_receiver_name,
      reworkOrderId: row.rework_order_id,
      reworkStatus: lifecycle(row.rework_status),
      version: row.version,
      rootMutable: row.root_mutable,
    }));
    const differenceQuantity = rows.reduce((sum, row) => sum + Math.abs(row.differenceQuantity), 0);
    const abnormalOrderCount = rows.filter((row) => row.differenceQuantity !== 0).length;
    const documentQuantity = rows.reduce((sum, row) => sum + row.documentQuantity, 0);
    return {
      date,
      kpis: {
        orderCount: rows.length,
        receivedQuantity: rows.reduce((sum, row) => sum + row.actualQuantity, 0),
        abnormalOrderCount,
        differenceQuantity,
        differenceRate: documentQuantity === 0 ? 0 : Number(((differenceQuantity / documentQuantity) * 100).toFixed(2)),
      },
      rows,
    };
  }
}

export { normalizeReceivingBackfillDate };
export type {
  BoardResult,
  CorrectReceivingBatchInput,
  CreateReceivingInput,
  ReceivingBatchSnapshot,
  ReceivingReceipt,
};
