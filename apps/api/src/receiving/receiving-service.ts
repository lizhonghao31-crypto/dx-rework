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

type CreateRepeatedReceivingInput = Readonly<{
  receivingBatchId: string;
  actualQuantity: number;
  defectiveQuantity?: number;
}>;

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
  attachmentIds?: readonly string[];
}>;

type RepeatReceivingOption = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
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

type ReceivingHistoryItem = Readonly<{
  receiptId: string;
  sequence: number;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  receivedAt: string;
  receiverName: string;
}>;
type BoardStatus = "all" | "normal" | "extra" | "short" | "multiple";

type BoardRow = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  attachments: readonly Readonly<{ attachmentId: string; filename: string }>[];
  priorActualQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  currentActualQuantity: number;
  currentDefectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  receiptCount: number;
  batchCount: number;
  receivingHistory: readonly ReceivingHistoryItem[];
  lastReceivedAt: string;
  lastReceiverName: string;
  reworkOrderId: string | null;
  reworkStatus: ReworkStatus;
  version: number;
  rootCorrectable: boolean;
  rootDeletable: boolean;
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
  startDate: string;
  endDate: string;
  mode: "range" | "search";
  status: BoardStatus;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    abnormalOrderCount: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
  nextCursor: string | null;
}>;

type BoardCursor = Readonly<{
  differenceRank: number;
  absoluteDifference: number;
  lastReceivedAt: string;
  styleKey: string;
  startDate: string;
  endDate: string;
  query: string;
  status: BoardStatus;
}>;

type Result<T> = Readonly<{ value: T; reused: boolean }>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

const fail = (message: string, status = 400, code = "VALIDATION_ERROR"): never => {
  throw new ApplicationError(code, message, status);
};

const normalizeStyleNo = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > 100) fail("款号不能为空且不能超过100个字符");
  return normalized;
};

const normalizeBoardStatus = (value: string): BoardStatus => {
  if (value === "" || value === "all") return "all";
  if (value === "normal" || value === "extra" || value === "short" || value === "multiple") return value;
  return fail("收货状态筛选无效");
};

const differenceRank = (difference: number): number => difference < 0 ? 0 : difference > 0 ? 1 : 2;

const decodeBoardCursor = (
  cursor: string,
  startDate: string,
  endDate: string,
  query: string,
  status: BoardStatus,
): BoardCursor | null => {
  if (!cursor) return null;
  if (cursor.length > 1000) fail("分页游标无效");
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
    if (!decoded || typeof decoded !== "object") throw new Error("invalid");
    const value = decoded as Record<string, unknown>;
    const rank = value.differenceRank;
    const absoluteDifference = value.absoluteDifference;
    const lastReceivedAt = value.lastReceivedAt;
    const styleKey = value.styleKey;
    if (
      (rank !== 0 && rank !== 1 && rank !== 2)
      || typeof absoluteDifference !== "number"
      || !Number.isSafeInteger(absoluteDifference)
      || absoluteDifference < 0
      || typeof lastReceivedAt !== "string"
      || Number.isNaN(Date.parse(lastReceivedAt))
      || typeof styleKey !== "string"
      || value.startDate !== startDate
      || value.endDate !== endDate
      || value.query !== query
      || value.status !== status
    ) {
      throw new Error("invalid");
    }
    return {
      differenceRank: rank as number,
      absoluteDifference: absoluteDifference as number,
      lastReceivedAt: lastReceivedAt as string,
      styleKey: styleKey as string,
      startDate,
      endDate,
      query,
      status,
    };
  } catch {
    return fail("分页游标无效");
  }
};

const encodeBoardCursor = (
  row: Readonly<{
    difference_quantity: string;
    last_received_cursor: string;
    style_no: string;
  }>,
  startDate: string,
  endDate: string,
  query: string,
  status: BoardStatus,
): string => {
  const difference = Number(row.difference_quantity);
  return Buffer.from(JSON.stringify({
  differenceRank: differenceRank(difference),
  absoluteDifference: Math.abs(difference),
  lastReceivedAt: row.last_received_cursor,
  styleKey: row.style_no,
  startDate,
  endDate,
  query,
  status,
  })).toString("base64url");
};

const RECEIVING_BOARD_BASE_SQL = `WITH scoped_styles AS (
         SELECT DISTINCT upper(btrim(batch.style_no)) AS style_key
         FROM receiving_receipts receipt
         JOIN receiving_batches batch
           ON batch.receiving_batch_id=receipt.receiving_batch_id
          AND batch.deleted_at IS NULL
         WHERE (
           $3::text<>''
           AND strpos(upper(btrim(batch.style_no)),$3)>0
         ) OR (
           $3::text=''
           AND receipt.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
           AND receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
         )
       ), scoped_batches AS (
         SELECT batch.receiving_batch_id,
                upper(btrim(batch.style_no)) AS style_key
         FROM receiving_batches batch
         JOIN scoped_styles scope
           ON scope.style_key=upper(btrim(batch.style_no))
         WHERE batch.deleted_at IS NULL
       ), correction_adjustments AS (
         SELECT event.entity_id::uuid AS receiving_batch_id,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at<($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS prior_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                    AND event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS period_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS through_end_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ),0)::bigint AS all_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'defectiveQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'defectiveQuantity')::bigint
                      -(event.before_state->>'defectiveQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                    AND event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS period_defective_adjustment
         FROM operation_events event
         JOIN scoped_batches scope ON scope.receiving_batch_id=event.entity_id::uuid
         WHERE event.action IN ('receiving.batch.correct','receiving.batch.merge')
           AND event.entity_type='receiving_batch'
         GROUP BY event.entity_id
       ), batch_totals AS (
         SELECT r.receiving_batch_id,
                scope.style_key,
                batch.delivery_note_quantity::bigint AS document_quantity,
                min(r.received_at) AS first_received_at,
                max(r.received_at) AS last_all_received_at,
                max(r.received_at) FILTER (
                  WHERE $3::text<>''
                     OR r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ) AS last_through_end_received_at,
                CASE WHEN $3::text<>'' THEN 0
                  ELSE (
                    COALESCE(sum(r.actual_quantity) FILTER (
                      WHERE r.received_at<($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                    ),0)
                    +COALESCE(adjustments.prior_actual_adjustment,0)
                    +batch.actual_quantity_adjustment-COALESCE(adjustments.all_actual_adjustment,0)
                  )
                END::bigint AS prior_actual_quantity,
                CASE WHEN $3::text<>'' THEN
                  sum(r.actual_quantity)+batch.actual_quantity_adjustment
                ELSE
                  COALESCE(sum(r.actual_quantity) FILTER (
                    WHERE r.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                      AND r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                  ),0)+COALESCE(adjustments.period_actual_adjustment,0)
                END::bigint AS actual_quantity,
                CASE WHEN $3::text<>'' THEN
                  sum(r.defective_quantity)+batch.defective_quantity_adjustment
                ELSE
                  COALESCE(sum(r.defective_quantity) FILTER (
                    WHERE r.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                      AND r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                  ),0)+COALESCE(adjustments.period_defective_adjustment,0)
                END::bigint AS defective_quantity,
                (sum(r.actual_quantity)+batch.actual_quantity_adjustment)::bigint AS current_actual_quantity,
                (sum(r.defective_quantity)+batch.defective_quantity_adjustment)::bigint AS current_defective_quantity,
                CASE WHEN $3::text<>'' THEN
                  sum(r.actual_quantity)+batch.actual_quantity_adjustment
                ELSE
                  COALESCE(sum(r.actual_quantity) FILTER (
                    WHERE r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                  ),0)
                  +COALESCE(adjustments.through_end_actual_adjustment,0)
                  +batch.actual_quantity_adjustment-COALESCE(adjustments.all_actual_adjustment,0)
                END::bigint AS cumulative_actual_quantity,
                (count(*) FILTER (
                  WHERE $3::text<>''
                     OR r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ))::bigint AS receipt_count,
                max(r.received_at) FILTER (
                  WHERE $3::text<>''
                     OR (
                       r.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                       AND r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                     )
                ) AS last_received_at,
                batch.version
         FROM receiving_receipts r
         JOIN scoped_batches scope
           ON scope.receiving_batch_id=r.receiving_batch_id
         JOIN receiving_batches batch
           ON batch.receiving_batch_id=r.receiving_batch_id
          AND batch.deleted_at IS NULL
         LEFT JOIN correction_adjustments adjustments
           ON adjustments.receiving_batch_id=r.receiving_batch_id
         GROUP BY r.receiving_batch_id,batch.receiving_batch_id,
                  scope.style_key,
                  adjustments.prior_actual_adjustment,adjustments.period_actual_adjustment,
                  adjustments.through_end_actual_adjustment,adjustments.all_actual_adjustment,
                  adjustments.period_defective_adjustment
       ), style_totals AS (
         SELECT totals.style_key,
                (array_agg(
                  totals.document_quantity
                  ORDER BY totals.first_received_at,totals.receiving_batch_id
                ))[1]::bigint AS document_quantity,
                sum(totals.prior_actual_quantity)::bigint AS prior_actual_quantity,
                sum(totals.actual_quantity)::bigint AS actual_quantity,
                sum(totals.defective_quantity)::bigint AS defective_quantity,
                sum(totals.current_actual_quantity)::bigint AS current_actual_quantity,
                sum(totals.current_defective_quantity)::bigint AS current_defective_quantity,
                sum(totals.cumulative_actual_quantity)::bigint AS cumulative_actual_quantity,
                sum(totals.receipt_count)::bigint AS receipt_count,
                count(*)::bigint AS batch_count,
                max(totals.last_received_at) AS last_received_at
         FROM batch_totals totals
         GROUP BY totals.style_key
       )`;

const validateQuantity = (value: number, label: string, allowZero: boolean): number => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 10_000_000) {
    fail(`${label}必须是${allowZero ? "大于等于0" : "大于0"}的整数`);
  }
  return value;
};

const normalizeAttachmentIds = (values: readonly string[] | undefined): readonly string[] => {
  const attachmentIds = values ?? [];
  if (attachmentIds.length > MAX_RECEIVING_IMAGES) fail("送货单图片最多3张");
  if (new Set(attachmentIds).size !== attachmentIds.length) fail("送货单图片不能重复");
  if (attachmentIds.some((value) => !UUID_PATTERN.test(value))) fail("送货单图片标识无效");
  return attachmentIds;
};

const normalizeReplacementAttachmentIds = (
  values: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (values === undefined) return undefined;
  const attachmentIds = normalizeAttachmentIds(values);
  if (attachmentIds.length === 0) fail("替换送货单图片至少选择1张");
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

const normalizeBoardDate = (value: string): string => {
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)
      || !Number.isFinite(parsed)
      || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail("日期格式必须为YYYY-MM-DD");
  }
  return value;
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
      documentQuantity: validateQuantity(input.documentQuantity, "送货单数量", false),
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

  async createRepeated(
    actor: TrustedActorContext,
    input: CreateRepeatedReceivingInput,
    idempotencyKey: string,
  ): Promise<Result<ReceivingReceipt>> {
    if (!UUID_PATTERN.test(input.receivingBatchId)) fail("收货订单标识无效");
    const actualQuantity = validateQuantity(input.actualQuantity, "实际收货数量", true);
    const defectiveQuantity = validateQuantity(input.defectiveQuantity ?? 0, "次品数量", true);
    if (defectiveQuantity > actualQuantity) fail("次品数量不能超过实际收货数量");
    const scope = "receiving.receipt.repeat";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, { receivingBatchId: input.receivingBatchId, actualQuantity, defectiveQuantity }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const target = await this.repeatReceivingBatch(client, input.receivingBatchId);
        return {
          statusCode: 201,
          response: await this.createInTransaction(client, actor, {
            styleNo: target.styleNo,
            documentQuantity: target.documentQuantity,
            actualQuantity,
            defectiveQuantity,
            attachmentIds: [],
            receivedDate: null,
          }, target.receivingBatchId),
        };
      });
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
    allowReworkHistory = false,
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
              batch.delivery_note_quantity::bigint AS document_quantity,
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
    if (row.has_rework_history && !allowReworkHistory) {
      fail("该订单已经发起过返工，不能再修改或删除", 409, "INVALID_STATE_TRANSITION");
    }
    return row;
  }

  private async replaceReceivingImages(
    client: PoolClient,
    actor: TrustedActorContext,
    receivingBatchId: string,
    attachmentIds: readonly string[] | undefined,
  ): Promise<void> {
    if (attachmentIds === undefined) return;
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
    if (candidates.rows.length !== attachmentIds.length) fail("送货单图片不存在或不可用");
    for (const row of candidates.rows) {
      if (row.status !== "ready") fail("送货单图片尚未上传完成");
      if (row.uploaded_by !== actor.actorId) fail("只能使用本人上传的送货单图片", 403, "FORBIDDEN");
      if (!RECEIVING_IMAGE_MIME_TYPES.has(row.mime_type)) fail("送货单图片仅支持JPEG、PNG、WebP");
      if (row.entity_type !== null || row.entity_id !== null) {
        fail("替换图片已绑定到其他业务记录", 409, "CONFLICT");
      }
    }
    const current = await client.query<{ attachment_id: string }>(
      `SELECT attachment.attachment_id
       FROM attachments attachment
       WHERE attachment.entity_type='receiving_batch'
         AND attachment.entity_id=$1
         AND attachment.status='ready'
         AND attachment.mime_type LIKE 'image/%'
         AND NOT EXISTS(
           SELECT 1 FROM receiving_attachment_retirements retired
           WHERE retired.attachment_id=attachment.attachment_id
         )
       FOR UPDATE`,
      [receivingBatchId],
    );
    const replacedAttachmentIds = current.rows.map((row) => row.attachment_id);
    const eventId = await this.events.append(client, actor, {
      action: "receiving.batch.images.replace",
      entityType: "receiving_batch",
      entityId: receivingBatchId,
      before: { receivingBatchId, attachmentIds: replacedAttachmentIds },
      after: { receivingBatchId, attachmentIds, replacedAttachmentIds },
    });
    await client.query(
      "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    await client.query(
      `UPDATE attachments
       SET entity_type='receiving_batch',entity_id=$2
       WHERE attachment_id=ANY($1::uuid[])
         AND entity_type IS NULL AND entity_id IS NULL`,
      [attachmentIds, receivingBatchId],
    );
    if (replacedAttachmentIds.length > 0) {
      await client.query(
        `INSERT INTO receiving_attachment_retirements(
           attachment_id,receiving_batch_id,operation_event_id,retired_by,request_id
         )
         SELECT unnest($1::uuid[]),$2,$3,$4,$5`,
        [replacedAttachmentIds, receivingBatchId, eventId, actor.actorId, actor.requestId],
      );
    }
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
      documentQuantity: validateQuantity(input.documentQuantity, "送货单数量", false),
      actualQuantity: validateQuantity(input.actualQuantity, "实际收货数量", true),
      defectiveQuantity: input.defectiveQuantity === undefined
        ? undefined
        : validateQuantity(input.defectiveQuantity, "次品数量", true),
      attachmentIds: normalizeReplacementAttachmentIds(input.attachmentIds),
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
      const current = await this.mutableBatch(client, receivingBatchId, true);
      if (current.version !== normalized.expectedVersion) {
        fail("收货订单已被其他人修改，请刷新后重试", 409, "CONFLICT");
      }
      if (current.has_rework_history && normalized.attachmentIds !== undefined) {
        fail("返工发起后不能替换送货单图片", 409, "INVALID_STATE_TRANSITION");
      }
      const defectiveQuantity = normalized.defectiveQuantity ?? Number(current.defective_quantity);
      if (defectiveQuantity > normalized.actualQuantity) fail("次品数量不能超过实际收货数量");
      const before: ReceivingBatchSnapshot = {
        receivingBatchId,
        styleNo: current.style_no,
        documentQuantity: Number(current.document_quantity),
        actualQuantity: Number(current.actual_quantity),
        defectiveQuantity: Number(current.defective_quantity),
        differenceQuantity: Number(current.actual_quantity) - Number(current.document_quantity),
        version: current.version,
      };

      const targetResult = current.has_rework_history ? { rows: [] } : await client.query<{
        receiving_batch_id: string;
        has_rework_history: boolean;
      }>(
        `SELECT target.receiving_batch_id,
                EXISTS(
                  SELECT 1 FROM rework_orders history
                  WHERE history.source_receiving_batch_id=target.receiving_batch_id
                ) AS has_rework_history
         FROM receiving_batches target
         WHERE upper(btrim(target.style_no))=$1
           AND $1<>upper(btrim($3))
           AND target.receiving_batch_id<>$2
           AND target.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1
             FROM receiving_receipts receipt
             JOIN operation_events event ON event.event_id=receipt.operation_event_id
             WHERE receipt.receiving_batch_id=target.receiving_batch_id
               AND event.after_state->>'backfilled'='true'
           )
         ORDER BY target.created_at DESC,target.receiving_batch_id DESC
         LIMIT 1`,
        [normalized.styleNo, receivingBatchId, current.style_no],
      );
      const targetRow = targetResult.rows[0];
      const targetId = targetRow?.receiving_batch_id;
      if (targetId) {
        const target = await this.mutableBatch(client, targetId, true);
        const targetBefore: ReceivingBatchSnapshot = {
          receivingBatchId: targetId,
          styleNo: target.style_no,
          documentQuantity: Number(target.document_quantity),
          actualQuantity: Number(target.actual_quantity),
          defectiveQuantity: Number(target.defective_quantity),
          differenceQuantity: Number(target.actual_quantity) - Number(target.document_quantity),
          version: target.version,
        };
        const after: ReceivingBatchSnapshot = {
          receivingBatchId: targetId,
          styleNo: target.style_no,
          documentQuantity: Number(target.document_quantity),
          actualQuantity: Number(target.actual_quantity) + normalized.actualQuantity,
          defectiveQuantity: Number(target.defective_quantity) + defectiveQuantity,
          differenceQuantity: Number(target.actual_quantity) + normalized.actualQuantity
            - Number(target.document_quantity),
          version: target.version + 1,
        };
        if (after.defectiveQuantity > after.actualQuantity) fail("合并后的次品数量不能超过实际收货数量");
        const sourceFacts = await client.query<{
          actual_quantity: string;
          defective_quantity: string;
        }>(
          `SELECT sum(actual_quantity)::bigint AS actual_quantity,
                  sum(defective_quantity)::bigint AS defective_quantity
           FROM receiving_receipts WHERE receiving_batch_id=$1`,
          [receivingBatchId],
        );
        const sourceActualAdjustment = normalized.actualQuantity
          - Number(sourceFacts.rows[0]?.actual_quantity ?? 0);
        const sourceDefectiveAdjustment = defectiveQuantity
          - Number(sourceFacts.rows[0]?.defective_quantity ?? 0);
        const mergeEventId = await this.events.append(client, actor, {
          action: "receiving.batch.merge",
          entityType: "receiving_batch",
          entityId: targetId,
          before: targetBefore,
          after: {
            ...after,
            sourceReceivingBatchId: receivingBatchId,
            targetReceivingBatchId: targetId,
            actualQuantityAdjustment: sourceActualAdjustment,
            defectiveQuantityAdjustment: sourceDefectiveAdjustment,
            source: { ...before, correctedStyleNo: normalized.styleNo },
          },
        });
        await client.query(
          "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
          [mergeEventId, actor.requestId],
        );
        await client.query(
          "UPDATE receiving_receipts SET receiving_batch_id=$2 WHERE receiving_batch_id=$1",
          [receivingBatchId, targetId],
        );
        await client.query(
          `UPDATE attachments SET entity_id=$2
           WHERE entity_type='receiving_batch' AND entity_id=$1`,
          [receivingBatchId, targetId],
        );
        await client.query("SELECT set_config('dx_rework.receiving_root_action','merge',true)");
        const merged = await client.query(
          `UPDATE receiving_batches batch
           SET document_quantity_adjustment=$2-(
                 SELECT sum(receipt.document_quantity) FROM receiving_receipts receipt
                 WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               ),
               actual_quantity_adjustment=$3-(
                 SELECT sum(receipt.actual_quantity) FROM receiving_receipts receipt
                 WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               ),
               defective_quantity_adjustment=$4-(
                 SELECT sum(receipt.defective_quantity) FROM receiving_receipts receipt
                 WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               ),
               version=batch.version+1,updated_by=$5,updated_at=clock_timestamp(),
               last_operation_event_id=$6,last_request_id=$7
           WHERE batch.receiving_batch_id=$1 AND batch.version=$8 AND batch.deleted_at IS NULL`,
          [
            targetId,
            after.documentQuantity,
            after.actualQuantity,
            after.defectiveQuantity,
            actor.actorId,
            mergeEventId,
            actor.requestId,
            target.version,
          ],
        );
        if (merged.rowCount !== 1) fail("目标收货订单状态已变化，请刷新后重试", 409, "CONFLICT");

        const deleteAfter = { ...before, version: current.version + 1, deleted: true as const, mergedInto: targetId };
        const deleteEventId = await this.events.append(client, actor, {
          action: "receiving.batch.delete",
          entityType: "receiving_batch",
          entityId: receivingBatchId,
          before,
          after: deleteAfter,
        });
        await client.query("SELECT set_config('dx_rework.receiving_root_action','delete',true)");
        const deleted = await client.query(
          `UPDATE receiving_batches
           SET deleted_at=clock_timestamp(),deleted_by=$2,version=version+1,
               updated_by=$2,updated_at=clock_timestamp(),
               last_operation_event_id=$3,last_request_id=$4
           WHERE receiving_batch_id=$1 AND version=$5 AND deleted_at IS NULL`,
          [receivingBatchId, actor.actorId, deleteEventId, actor.requestId, current.version],
        );
        if (deleted.rowCount !== 1) fail("来源收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
        await this.replaceReceivingImages(client, actor, targetId, normalized.attachmentIds);
        await client.query("COMMIT");
        return after;
      }

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
        "SELECT set_config('dx_rework.receiving_root_action','correct',true),set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
        [eventId, actor.requestId],
      );
      const updated = await client.query(
        `UPDATE receiving_batches batch
         SET style_no=$2,delivery_note_quantity=$3,
             document_quantity_adjustment=$3-(SELECT sum(document_quantity) FROM receiving_receipts WHERE receiving_batch_id=batch.receiving_batch_id),
             actual_quantity_adjustment=$4-(SELECT sum(actual_quantity) FROM receiving_receipts WHERE receiving_batch_id=batch.receiving_batch_id),
             defective_quantity_adjustment=$5-(SELECT sum(defective_quantity) FROM receiving_receipts WHERE receiving_batch_id=batch.receiving_batch_id),
             version=batch.version+1,updated_by=$6,updated_at=clock_timestamp(),
             last_operation_event_id=$7,last_request_id=$8
         WHERE batch.receiving_batch_id=$1 AND batch.version=$9 AND batch.deleted_at IS NULL`,
        [receivingBatchId, normalized.styleNo, normalized.documentQuantity, normalized.actualQuantity,
          defectiveQuantity, actor.actorId, eventId, actor.requestId, normalized.expectedVersion],
      );
      if (updated.rowCount !== 1) fail("收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
      if (current.has_rework_history && current.style_no !== normalized.styleNo) {
        await client.query(
          `UPDATE rework_orders
           SET style_no=$2,version=version+1,updated_by=$3,updated_at=clock_timestamp()
           WHERE source_receiving_batch_id=$1 AND style_no IS DISTINCT FROM $2`,
          [receivingBatchId, normalized.styleNo, actor.actorId],
        );
      }
      await this.replaceReceivingImages(client, actor, receivingBatchId, normalized.attachmentIds);
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

  private async repeatReceivingBatch(
    client: PoolClient,
    receivingBatchId: string,
  ): Promise<{ receivingBatchId: string; styleNo: string; documentQuantity: number }> {
    const initial = await client.query<{ style_no: string }>(
      `SELECT style_no FROM receiving_batches
       WHERE receiving_batch_id=$1 AND deleted_at IS NULL`,
      [receivingBatchId],
    );
    const initialRow = initial.rows[0];
    if (!initialRow) return fail("收货订单不存在", 404, "NOT_FOUND");
    const styleNo = normalizeStyleNo(initialRow.style_no);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [styleNo]);
    const target = await client.query<{
      receiving_batch_id: string;
      style_no: string;
      document_quantity: string;
    }>(
      `SELECT batch.receiving_batch_id,
              upper(btrim(batch.style_no)) AS style_no,
              batch.delivery_note_quantity::bigint AS document_quantity
       FROM receiving_batches batch
       WHERE batch.receiving_batch_id=$1
         AND batch.deleted_at IS NULL
         AND NOT EXISTS(
           SELECT 1 FROM receiving_receipts receipt
           JOIN operation_events event ON event.event_id=receipt.operation_event_id
           WHERE receipt.receiving_batch_id=batch.receiving_batch_id
             AND event.after_state->>'backfilled'='true'
         )
         AND NOT EXISTS(
           SELECT 1 FROM rework_orders rework
           WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
             AND (
               rework.status='completed'
               OR EXISTS(
                 SELECT 1 FROM operation_events event
                 WHERE event.entity_type='rework_order'
                   AND event.entity_id=rework.rework_order_id::text
                   AND event.after_state->>'status'='completed'
               )
             )
         )
         AND EXISTS(
           SELECT 1 FROM attachments attachment
           WHERE attachment.entity_type='receiving_batch'
             AND attachment.entity_id=batch.receiving_batch_id::text
             AND attachment.status='ready'
             AND NOT EXISTS(
               SELECT 1 FROM receiving_attachment_retirements retired
               WHERE retired.attachment_id=attachment.attachment_id
             )
         )
         AND batch.receiving_batch_id=(
           SELECT latest.receiving_batch_id
           FROM receiving_batches latest
           WHERE upper(btrim(latest.style_no))=$2
             AND latest.deleted_at IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM receiving_receipts receipt
               JOIN operation_events event ON event.event_id=receipt.operation_event_id
               WHERE receipt.receiving_batch_id=latest.receiving_batch_id
                 AND event.after_state->>'backfilled'='true'
             )
           ORDER BY latest.created_at DESC,latest.receiving_batch_id DESC
           LIMIT 1
         )
       FOR UPDATE OF batch`,
      [receivingBatchId, styleNo],
    );
    const row = target.rows[0];
    if (!row) return fail("该订单已不可追加收货，请重新搜索选择", 409, "INVALID_STATE_TRANSITION");
    return {
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
    };
  }

  private async resolveReceivingBatch(
    client: PoolClient,
    actor: TrustedActorContext,
    styleNo: string,
    documentQuantity: number,
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
       WHERE upper(btrim(batch.style_no))=$1
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
      `INSERT INTO receiving_batches(
         receiving_batch_id,style_no,delivery_note_quantity,created_by,created_at
       ) VALUES($1,$2,$3,$4,COALESCE(
         ($5::date+(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
         CURRENT_TIMESTAMP
       ))`,
      [receivingBatchId, styleNo, documentQuantity, actor.actorId, receivedDate],
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
       WHERE entity_type='receiving_batch' AND entity_id=$1 AND status='ready'
         AND NOT EXISTS(
           SELECT 1 FROM receiving_attachment_retirements retired
           WHERE retired.attachment_id=attachments.attachment_id
         )`,
      [receivingBatchId],
    );
    const existingCount = Number(existing.rows[0]?.count ?? 0);

    if (attachmentIds.length === 0) {
      if (existingCount === 0) fail("送货单图片必传，最多3张");
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
    if (candidates.rows.length !== attachmentIds.length) fail("送货单图片不存在或不可用");

    let newBindings = 0;
    for (const row of candidates.rows) {
      if (row.status !== "ready") fail("送货单图片尚未上传完成");
      if (row.uploaded_by !== actor.actorId) fail("只能使用本人上传的送货单图片", 403, "FORBIDDEN");
      if (!RECEIVING_IMAGE_MIME_TYPES.has(row.mime_type)) fail("送货单图片仅支持JPEG、PNG、WebP");
      const alreadyBound = row.entity_type === "receiving_batch" && row.entity_id === receivingBatchId;
      if (row.entity_type !== null && !alreadyBound) fail("送货单图片已绑定到其他业务记录", 409, "CONFLICT");
      if (!alreadyBound) newBindings += 1;
    }
    if (existingCount + newBindings > MAX_RECEIVING_IMAGES) fail("送货单图片最多3张");

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
    targetReceivingBatchId?: string,
  ): Promise<ReceivingReceipt> {
    const receivingBatchId = targetReceivingBatchId ?? (await this.resolveReceivingBatch(
      client,
      actor,
      input.styleNo,
      input.documentQuantity,
      input.receivedDate,
    )).receivingBatchId;
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

  async listRepeatOptions(query = ""): Promise<readonly RepeatReceivingOption[]> {
    const needle = query.trim().toUpperCase();
    const result = await this.database.query<{
      receiving_batch_id: string;
      style_no: string;
      document_quantity: string;
    }>(
      `WITH ranked AS (
         SELECT batch.receiving_batch_id,
                upper(btrim(batch.style_no)) AS style_no,
                batch.delivery_note_quantity::bigint AS document_quantity,
                row_number() OVER (
                  PARTITION BY upper(btrim(batch.style_no))
                  ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
                ) AS position,
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
                ) AS closed,
                EXISTS(
                  SELECT 1 FROM attachments attachment
                  WHERE attachment.entity_type='receiving_batch'
                    AND attachment.entity_id=batch.receiving_batch_id::text
                    AND attachment.status='ready'
                    AND NOT EXISTS(
                      SELECT 1 FROM receiving_attachment_retirements retired
                      WHERE retired.attachment_id=attachment.attachment_id
                    )
                ) AS has_images
         FROM receiving_batches batch
         WHERE batch.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1
             FROM receiving_receipts receipt
             JOIN operation_events event ON event.event_id=receipt.operation_event_id
             WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               AND event.after_state->>'backfilled'='true'
           )
       )
       SELECT receiving_batch_id,style_no,document_quantity
       FROM ranked
       WHERE position=1 AND NOT closed AND has_images
         AND ($1::text='' OR right(style_no,char_length($1))=$1)
       ORDER BY style_no
       LIMIT 20`,
      [needle],
    );
    return result.rows.map((row) => ({
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
    }));
  }

  async listStyleOptions(query = ""): Promise<readonly string[]> {
    const needle = query.trim().toUpperCase();
    const result = await this.database.query<{ style_no: string }>(
      `SELECT DISTINCT upper(btrim(source.style_no)) AS style_no
       FROM (
         SELECT style_no FROM receiving_batches WHERE deleted_at IS NULL
         UNION
         SELECT style_no FROM rework_orders WHERE style_no IS NOT NULL AND status<>'deleted'
       ) source
       WHERE ($1::text='' OR upper(btrim(source.style_no)) LIKE '%' || $1 || '%')
       ORDER BY style_no
       LIMIT 100`,
      [needle],
    );
    return result.rows.map((row) => row.style_no);
  }

  async board(
    startDateInput: string,
    endDateOrQuery = startDateInput,
    query = "",
    statusInput = "all",
    cursor = "",
  ): Promise<BoardResult> {
    const startDate = normalizeBoardDate(startDateInput);
    const hasExplicitEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDateOrQuery);
    const endDate = normalizeBoardDate(hasExplicitEndDate ? endDateOrQuery : startDate);
    if (endDate < startDate) fail("结束日期不能早于开始日期");
    const needle = (hasExplicitEndDate ? query : endDateOrQuery).trim().toUpperCase();
    const status = normalizeBoardStatus(statusInput);
    const mode = needle ? "search" : "range";
    const pageCursor = decodeBoardCursor(cursor, startDate, endDate, needle, status);

    const client = await this.database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const summaryResult = await client.query<{
      order_count: string;
      received_quantity: string;
      abnormal_order_count: string;
      difference_quantity: string;
      document_quantity: string;
    }>(
      `${RECEIVING_BOARD_BASE_SQL}, filtered_totals AS (
         SELECT totals.*,
                totals.cumulative_actual_quantity-totals.document_quantity AS difference_quantity,
                abs(totals.cumulative_actual_quantity-totals.document_quantity) AS absolute_difference,
                CASE
                  WHEN totals.cumulative_actual_quantity-totals.document_quantity<0 THEN 0
                  WHEN totals.cumulative_actual_quantity-totals.document_quantity>0 THEN 1
                  ELSE 2
                END AS difference_rank
         FROM style_totals totals
         WHERE $4='all'
            OR ($4='multiple' AND totals.receipt_count>1)
            OR ($4='normal' AND totals.cumulative_actual_quantity-totals.document_quantity=0)
            OR ($4='short' AND totals.cumulative_actual_quantity-totals.document_quantity<0)
            OR ($4='extra' AND totals.cumulative_actual_quantity-totals.document_quantity>0)
       )
       SELECT count(*)::bigint AS order_count,
              COALESCE(sum(actual_quantity),0)::bigint AS received_quantity,
              count(*) FILTER (WHERE difference_quantity<>0)::bigint AS abnormal_order_count,
              COALESCE(sum(absolute_difference),0)::bigint AS difference_quantity,
              COALESCE(sum(document_quantity),0)::bigint AS document_quantity
       FROM filtered_totals`,
      [startDate, endDate, needle, status],
    );
    const summary = summaryResult.rows[0]!;

      const rowsResult = await client.query<{
      receiving_batch_id: string;
      style_no: string;
      document_quantity: string;
      receiving_attachments: { attachmentId: string; filename: string }[];
      prior_actual_quantity: string;
      actual_quantity: string;
      defective_quantity: string;
      current_actual_quantity: string;
      current_defective_quantity: string;
      cumulative_actual_quantity: string;
      difference_quantity: string;
      receipt_count: string;
      batch_count: string;
      receiving_history: ReceivingHistoryItem[];
      last_received_at: Date;
      last_received_cursor: string;
      last_receiver_name: string;
      rework_order_id: string | null;
      rework_status: string | null;
      version: number;
      root_correctable: boolean;
      root_deletable: boolean;
      root_mutable: boolean;
    }>(
      `${RECEIVING_BOARD_BASE_SQL}, filtered_totals AS (
         SELECT totals.*,
                totals.cumulative_actual_quantity-totals.document_quantity AS difference_quantity,
                abs(totals.cumulative_actual_quantity-totals.document_quantity) AS absolute_difference,
                CASE
                  WHEN totals.cumulative_actual_quantity-totals.document_quantity<0 THEN 0
                  WHEN totals.cumulative_actual_quantity-totals.document_quantity>0 THEN 1
                  ELSE 2
                END AS difference_rank
         FROM style_totals totals
         WHERE $4='all'
            OR ($4='multiple' AND totals.receipt_count>1)
            OR ($4='normal' AND totals.cumulative_actual_quantity-totals.document_quantity=0)
            OR ($4='short' AND totals.cumulative_actual_quantity-totals.document_quantity<0)
            OR ($4='extra' AND totals.cumulative_actual_quantity-totals.document_quantity>0)
       ), page_totals AS (
         SELECT *
         FROM filtered_totals
         WHERE $5::integer IS NULL
            OR difference_rank>$5::integer
            OR (
              difference_rank=$5::integer
              AND (
                absolute_difference<$6::bigint
                OR (
                  absolute_difference=$6::bigint
                  AND (
                    last_received_at<$7::timestamptz
                    OR (last_received_at=$7::timestamptz AND style_key>$8::text)
                  )
                )
              )
            )
         ORDER BY difference_rank ASC,absolute_difference DESC,last_received_at DESC,style_key ASC
         LIMIT 16
       )
       SELECT action.receiving_batch_id,totals.style_key AS style_no,totals.document_quantity,
              totals.prior_actual_quantity,totals.actual_quantity,totals.defective_quantity,
              totals.current_actual_quantity,totals.current_defective_quantity,
              totals.cumulative_actual_quantity,
              totals.cumulative_actual_quantity-totals.document_quantity AS difference_quantity,
              totals.receipt_count,totals.batch_count,
              COALESCE(receiving_history.items,'[]'::jsonb) AS receiving_history,
              totals.last_received_at,
              to_char(
                totals.last_received_at AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
              ) AS last_received_cursor,
              receiver.display_name AS last_receiver_name,
              rework.rework_order_id,rework.status AS rework_status,
              COALESCE(receiving_attachments.items,'[]'::jsonb) AS receiving_attachments,
              action.version,
              totals.batch_count=1 AS root_correctable,
              totals.batch_count=1 AND NOT EXISTS(
                SELECT 1 FROM rework_orders history
                WHERE history.source_receiving_batch_id=action.receiving_batch_id
              ) AS root_deletable,
              totals.batch_count=1 AND NOT EXISTS(
                SELECT 1 FROM rework_orders history
                WHERE history.source_receiving_batch_id=action.receiving_batch_id
              ) AS root_mutable
       FROM page_totals totals
       JOIN LATERAL (
         SELECT batch.receiving_batch_id,batch.version
         FROM batch_totals batch
         WHERE batch.style_key=totals.style_key
         ORDER BY batch.last_through_end_received_at DESC NULLS LAST,
                  batch.receiving_batch_id DESC
         LIMIT 1
       ) action ON true
       JOIN LATERAL (
         SELECT u.display_name
         FROM receiving_receipts latest
         JOIN receiving_batches latest_batch
           ON latest_batch.receiving_batch_id=latest.receiving_batch_id
          AND latest_batch.deleted_at IS NULL
         JOIN app_users u ON u.id=latest.received_by
         WHERE upper(btrim(latest_batch.style_no))=totals.style_key
           AND (
             $3::text<>''
             OR (
               latest.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
               AND latest.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
             )
           )
         ORDER BY latest.received_at DESC,latest.receipt_id DESC
         LIMIT 1
       ) receiver ON true
       LEFT JOIN LATERAL (
         SELECT item.rework_order_id,item.status
         FROM rework_orders item
         WHERE item.status<>'deleted'
           AND (
             (
               item.status NOT IN ('completed','cancelled')
               AND EXISTS (
                 SELECT 1
                 FROM scoped_batches source_batch
                 WHERE source_batch.receiving_batch_id=item.source_receiving_batch_id
                   AND source_batch.style_key=totals.style_key
               )
             )
             OR item.source_receiving_batch_id=action.receiving_batch_id
           )
         ORDER BY
           CASE WHEN item.status NOT IN ('completed','cancelled') THEN 0 ELSE 1 END,
           CASE WHEN item.status='draft' THEN 1 ELSE 0 END,
           item.updated_at DESC,item.rework_order_id DESC
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
           AND attachment.entity_id IN (
             SELECT scope.receiving_batch_id::text
             FROM scoped_batches scope
             WHERE scope.style_key=totals.style_key
           )
           AND attachment.status='ready'
           AND attachment.mime_type LIKE 'image/%'
           AND NOT EXISTS(
             SELECT 1 FROM receiving_attachment_retirements retired
             WHERE retired.attachment_id=attachment.attachment_id
           )
       ) receiving_attachments ON true
       LEFT JOIN LATERAL (
         SELECT jsonb_agg(
                  jsonb_build_object(
                    'receiptId',history.receipt_id,
                    'sequence',history.sequence,
                    'documentQuantity',totals.document_quantity,
                    'actualQuantity',history.actual_quantity,
                    'defectiveQuantity',history.defective_quantity,
                    'cumulativeActualQuantity',history.cumulative_actual_quantity,
                    'differenceQuantity',history.cumulative_actual_quantity-totals.document_quantity,
                    'receivedAt',history.received_at,
                    'receiverName',history.receiver_name
                  )
                  ORDER BY history.received_at DESC,history.receipt_id DESC
                ) AS items
         FROM (
           SELECT receipt.receipt_id,
                  receipt.actual_quantity::bigint AS actual_quantity,
                  receipt.defective_quantity::bigint AS defective_quantity,
                  receipt.received_at,
                  users.display_name AS receiver_name,
                  row_number() OVER (
                    ORDER BY receipt.received_at,receipt.receipt_id
                  )::int AS sequence,
                  sum(receipt.actual_quantity) OVER (
                    ORDER BY receipt.received_at,receipt.receipt_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  )::bigint AS cumulative_actual_quantity
           FROM receiving_receipts receipt
           JOIN receiving_batches history_batch
             ON history_batch.receiving_batch_id=receipt.receiving_batch_id
            AND history_batch.deleted_at IS NULL
           JOIN app_users users ON users.id=receipt.received_by
           WHERE upper(btrim(history_batch.style_no))=totals.style_key
             AND (
               $3::text<>''
               OR receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
             )
         ) history
       ) receiving_history ON true
       ORDER BY totals.difference_rank ASC,totals.absolute_difference DESC,
                totals.last_received_at DESC,totals.style_key ASC`,
      [
        startDate,
        endDate,
        needle,
        status,
        pageCursor?.differenceRank ?? null,
        pageCursor?.absoluteDifference ?? null,
        pageCursor?.lastReceivedAt ?? null,
        pageCursor?.styleKey ?? null,
      ],
    );
    const allRows: BoardRow[] = rowsResult.rows.map((row) => ({
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
      attachments: row.receiving_attachments,
      priorActualQuantity: Number(row.prior_actual_quantity),
      actualQuantity: Number(row.actual_quantity),
      defectiveQuantity: Number(row.defective_quantity),
      currentActualQuantity: Number(row.current_actual_quantity),
      currentDefectiveQuantity: Number(row.current_defective_quantity),
      cumulativeActualQuantity: Number(row.cumulative_actual_quantity),
      differenceQuantity: Number(row.difference_quantity),
      receiptCount: Number(row.receipt_count),
      batchCount: Number(row.batch_count),
      receivingHistory: row.receiving_history.map((item) => ({
        ...item,
        sequence: Number(item.sequence),
        documentQuantity: Number(item.documentQuantity),
        actualQuantity: Number(item.actualQuantity),
        defectiveQuantity: Number(item.defectiveQuantity),
        cumulativeActualQuantity: Number(item.cumulativeActualQuantity),
        differenceQuantity: Number(item.differenceQuantity),
      })),
      lastReceivedAt: row.last_received_at.toISOString(),
      lastReceiverName: row.last_receiver_name,
      reworkOrderId: row.rework_order_id,
      reworkStatus: lifecycle(row.rework_status),
      version: row.version,
      rootCorrectable: row.root_correctable,
      rootDeletable: row.root_deletable,
      rootMutable: row.root_mutable,
    }));
    const rows = allRows.slice(0, 15);
    const differenceQuantity = Number(summary.difference_quantity);
    const documentQuantity = Number(summary.document_quantity);
      await client.query("COMMIT");
      return {
      date: endDate,
      startDate,
      endDate,
      mode,
      status,
      kpis: {
        orderCount: Number(summary.order_count),
        receivedQuantity: Number(summary.received_quantity),
        abnormalOrderCount: Number(summary.abnormal_order_count),
        differenceQuantity,
        differenceRate: documentQuantity === 0
          ? 0
          : Number(((differenceQuantity / documentQuantity) * 100).toFixed(2)),
      },
      rows,
      nextCursor: allRows.length > 15
        ? encodeBoardCursor(rowsResult.rows[14]!, startDate, endDate, needle, status)
        : null,
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

}

export { normalizeReceivingBackfillDate };
export type {
  BoardResult,
  CorrectReceivingBatchInput,
  CreateRepeatedReceivingInput,
  RepeatReceivingOption,
  CreateReceivingInput,
  ReceivingBatchSnapshot,
  ReceivingReceipt,
};
