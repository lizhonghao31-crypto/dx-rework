import type {Pool} from "pg";
import {ApplicationError} from "../platform/errors.js";
import {RECEIVING_BOARD_BASE_SQL,RECEIVING_BATCH_BOARD_BASE_SQL,type ReceiptSource,type ReceivingDifferenceType} from "./receiving-quantity-query.js";
import {RECEIVING_BOARD_FILTERS_SQL} from "./receiving-board-filters.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (message: string, status = 400, code = "VALIDATION_ERROR"): never => {
  throw new ApplicationError(code, message, status);
};

type DifferenceResolution = Readonly<{
  resolutionId: string;
  result: string;
  handledBy: string;
  handledAt: string;
  attachments: readonly Readonly<{ attachmentId: string; filename: string }>[];
}>;

type ReworkStatus = "draft" | "active" | "completed" | null;

type ReceivingHistoryItem = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  batchVersion: number;
  sequence: number;
  documentQuantity: number;
  receiptDocumentQuantity: number;
  receivingSource: ReceiptSource;
  actualQuantity: number;
  defectiveQuantity: number;
  cumulativeActualQuantity: number;
  differenceQuantity: number;
  receivedAt: string;
  receiverName: string;
}>;
type BoardStatus = "all" | "normal" | "extra" | "short" | "multiple" | "receiving_difference" | "packing_difference" | "missing_packing" | "pending" | "handled" | "stale";

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
  packingRevisionId: string | null;
  packingQuantity: number | null;
  packingDifferenceQuantity: number | null;
  packingRecordedBy: string | null;
  packingRecordedAt: string | null;
  actualCutCount: number | null;
  cuttingRecordedBy: string | null;
  cuttingRecordedAt: string | null;
  receivingDifferenceResolution: DifferenceResolution | null;
  packingDifferenceResolution: DifferenceResolution | null;
  staleResolution: boolean;
  resolutionHistory: readonly (DifferenceResolution & { differenceType: ReceivingDifferenceType; differenceQuantity: number })[];
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

export type BoardResult = Readonly<{
  date: string;
  startDate: string;
  endDate: string;
  mode: "range" | "search";
  status: BoardStatus;
  insights: Readonly<{ pendingCount: number; missingPackingCount: number; staleCount: number }>;
  kpis: Readonly<{
    orderCount: number;
    receivedQuantity: number;
    abnormalOrderCount: number;
    differenceQuantity: number;
    differenceRate: number;
  }>;
  rows: readonly BoardRow[];
  page: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
}>;

const normalizeBoardStatus = (value: string): BoardStatus => {
  if (value === "" || value === "all") return "all";
  if (value === "normal" || value === "extra" || value === "short" || value === "multiple") return value;
  if (value === "receiving_difference" || value === "packing_difference" || value === "missing_packing" || value === "pending" || value === "handled" || value === "stale") return value;
  return fail("收货状态筛选无效");
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

const normalizeOptionalUuid = (value: string | null | undefined, label: string): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (!UUID_PATTERN.test(value)) fail(`${label}无效`);
  return value;
};

const lifecycle = (status: string | null): ReworkStatus => {
  if (!status || status === "cancelled" || status === "deleted") return null;
  if (status === "draft") return "draft";
  if (status === "completed") return "completed";
  return "active";
};

/** Read-only snapshot owner: KPI and page share the original RR transaction. */
export async function readReceivingBoard(
    database: Pool,
    startDateInput: string,
    endDateOrQuery = startDateInput,
    query = "",
    statusInput = "all",
    pageInput = 1,
    pageSizeInput = 15,
    targetBatchId?: string,
  ): Promise<BoardResult> {
    const startDate = normalizeBoardDate(startDateInput);
    const hasExplicitEndDate = /^\d{4}-\d{2}-\d{2}$/.test(endDateOrQuery);
    const endDate = normalizeBoardDate(hasExplicitEndDate ? endDateOrQuery : startDate);
    if (endDate < startDate) fail("结束日期不能早于开始日期");
    const target = normalizeOptionalUuid(targetBatchId, "收货批次标识");
    const needle = target ?? (hasExplicitEndDate ? query : endDateOrQuery).trim().toUpperCase();
    const boardBaseSql = target ? RECEIVING_BATCH_BOARD_BASE_SQL : RECEIVING_BOARD_BASE_SQL;
    const status = normalizeBoardStatus(statusInput);
    const mode = needle ? "search" : "range";
    const page = Number.isInteger(pageInput) && pageInput > 0 ? pageInput : fail("分页页码无效");
    const pageSize = Number.isInteger(pageSizeInput) && pageSizeInput > 0 && pageSizeInput <= 50_001
      ? pageSizeInput
      : fail("分页数量无效");
    const offset = (page - 1) * pageSize;

    const client = await database.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const summaryResult = await client.query<{
      pending_count: string;
      missing_packing_count: string;
      stale_count: string;
      order_count: string;
      received_quantity: string;
      abnormal_order_count: string;
      difference_quantity: string;
      document_quantity: string;
    }>(
      `${boardBaseSql}${RECEIVING_BOARD_FILTERS_SQL}
       SELECT count(*) FILTER(WHERE pending_difference)::text AS pending_count,
              count(*) FILTER(WHERE missing_packing)::text AS missing_packing_count,
              count(*) FILTER(WHERE stale_resolution)::text AS stale_count,
              count(*)::bigint AS order_count,
              COALESCE(sum(actual_quantity),0)::bigint AS received_quantity,
              count(*) FILTER (WHERE difference_quantity<>0)::bigint AS abnormal_order_count,
              COALESCE(sum(absolute_difference),0)::bigint AS difference_quantity,
              COALESCE(sum(document_quantity),0)::bigint AS document_quantity
       FROM filtered_totals`,
      [startDate, endDate, needle, status],
    );
    const summary = summaryResult.rows[0]!;

      const defaultPage = pageSize === 15;
      const pageWindowSql = defaultPage ? "LIMIT 15 OFFSET $5" : "LIMIT $5 OFFSET $6";
      const pageWindowParameters = defaultPage
        ? [startDate, endDate, needle, status, offset]
        : [startDate, endDate, needle, status, pageSize, offset];
      const rowsResult = await client.query<{
      stale_resolution: boolean;
      resolution_history: { resolutionId: string; differenceType: ReceivingDifferenceType; differenceQuantity: number; result: string; handledBy: string; handledAt: string; attachments: {attachmentId: string; filename: string}[] }[];
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
      packing_revision_id: string | null;
      packing_quantity: string | null;
      packing_recorded_by: string | null;
      packing_recorded_at: Date | null;
      actual_cut_count: string | null;
      cutting_recorded_by: string | null;
      cutting_recorded_at: Date | null;
      receiving_resolution_id: string | null;
      receiving_resolution_result: string | null;
      receiving_resolution_handled_by: string | null;
      receiving_resolution_handled_at: Date | null;
      receiving_resolution_attachments: { attachmentId: string; filename: string }[];
      packing_resolution_id: string | null;
      packing_resolution_result: string | null;
      packing_resolution_handled_by: string | null;
      packing_resolution_handled_at: Date | null;
      packing_resolution_attachments: { attachmentId: string; filename: string }[];
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
      `${boardBaseSql}${RECEIVING_BOARD_FILTERS_SQL}, page_totals AS (
         SELECT *
         FROM filtered_totals
         ORDER BY difference_rank ASC,absolute_difference DESC,last_received_at DESC,style_key ASC,group_key ASC
         ${pageWindowSql}
       )
       SELECT totals.stale_resolution,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('resolutionId',r.resolution_id,
                'differenceType',r.difference_type,'differenceQuantity',r.difference_quantity_snapshot,
                'result',r.result,'handledBy',u.display_name,'handledAt',r.created_at,
                'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',a.attachment_id,'filename',a.original_filename))
                  FROM attachments a WHERE a.entity_type='receiving_difference_resolution' AND a.entity_id=r.resolution_id::text AND a.status='ready'),'[]'::jsonb))
                ORDER BY r.created_at DESC,r.resolution_id DESC)
                FROM receiving_difference_resolutions r JOIN scoped_batches b USING(receiving_batch_id)
                LEFT JOIN app_users u ON u.id=r.handled_by WHERE b.group_key=totals.group_key),'[]'::jsonb) AS resolution_history,
              action.receiving_batch_id,totals.style_key AS style_no,totals.document_quantity,
              totals.prior_actual_quantity,totals.actual_quantity,totals.defective_quantity,
              totals.current_actual_quantity,totals.current_defective_quantity,
              totals.cumulative_actual_quantity,
              totals.cumulative_actual_quantity-totals.document_quantity AS difference_quantity,
              packing.packing_revision_id,packing.packing_quantity,
              packing_user.display_name AS packing_recorded_by,
              packing.created_at AS packing_recorded_at,
              cutting_record.actual_cut_count,
              cutting_user.display_name AS cutting_recorded_by,
              cutting_record.recorded_at AS cutting_recorded_at,
              receiving_resolution.resolution_id AS receiving_resolution_id,
              receiving_resolution.result AS receiving_resolution_result,
              receiving_resolution_user.display_name AS receiving_resolution_handled_by,
              receiving_resolution.created_at AS receiving_resolution_handled_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',evidence.attachment_id,
                'filename',evidence.original_filename) ORDER BY evidence.created_at,evidence.attachment_id)
                FROM attachments evidence WHERE evidence.entity_type='receiving_difference_resolution'
                  AND evidence.entity_id=receiving_resolution.resolution_id::text AND evidence.status='ready'),
                '[]'::jsonb) AS receiving_resolution_attachments,
              packing_resolution.resolution_id AS packing_resolution_id,
              packing_resolution.result AS packing_resolution_result,
              packing_resolution_user.display_name AS packing_resolution_handled_by,
              packing_resolution.created_at AS packing_resolution_handled_at,
              COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',evidence.attachment_id,
                'filename',evidence.original_filename) ORDER BY evidence.created_at,evidence.attachment_id)
                FROM attachments evidence WHERE evidence.entity_type='receiving_difference_resolution'
                  AND evidence.entity_id=packing_resolution.resolution_id::text AND evidence.status='ready'),
                '[]'::jsonb) AS packing_resolution_attachments,
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
         SELECT batch.receiving_batch_id,batch.version,batch.cutting_order_id
         FROM batch_totals batch
         WHERE batch.group_key=totals.group_key
         ORDER BY batch.last_through_end_received_at DESC NULLS LAST,
                  batch.receiving_batch_id DESC
         LIMIT 1
       ) action ON true
       LEFT JOIN LATERAL (
         SELECT revision.packing_revision_id,revision.packing_quantity,revision.recorded_by,revision.created_at
         FROM receiving_packing_revisions revision
         WHERE revision.receiving_batch_id=action.receiving_batch_id
         ORDER BY revision.created_at DESC,revision.packing_revision_id DESC
         LIMIT 1
       ) packing ON true
       LEFT JOIN app_users packing_user ON packing_user.id=packing.recorded_by
       LEFT JOIN current_cutting_records cutting_record
         ON cutting_record.cutting_order_id=action.cutting_order_id
       LEFT JOIN app_users cutting_user ON cutting_user.id=cutting_record.recorded_by
       LEFT JOIN LATERAL (
         SELECT resolution.resolution_id,resolution.result,resolution.handled_by,resolution.created_at
         FROM receiving_difference_resolutions resolution
         WHERE resolution.receiving_batch_id=action.receiving_batch_id
           AND resolution.difference_type='receiving'
           AND resolution.document_quantity_snapshot=totals.document_quantity
           AND resolution.actual_quantity_snapshot=totals.cumulative_actual_quantity
           AND resolution.difference_quantity_snapshot=totals.cumulative_actual_quantity-totals.document_quantity
           AND COALESCE((SELECT event.after_state->>'quantityRevision' FROM operation_events event WHERE event.event_id=resolution.operation_event_id)=totals.receiving_quantity_revision,
            totals.receiving_quantity_changed_at IS NULL OR resolution.created_at>=totals.receiving_quantity_changed_at)
         ORDER BY resolution.created_at DESC,resolution.resolution_id DESC
         LIMIT 1
       ) receiving_resolution ON true
       LEFT JOIN app_users receiving_resolution_user ON receiving_resolution_user.id=receiving_resolution.handled_by
       LEFT JOIN LATERAL (
         SELECT resolution.resolution_id,resolution.result,resolution.handled_by,resolution.created_at
         FROM receiving_difference_resolutions resolution
         WHERE resolution.receiving_batch_id=action.receiving_batch_id
           AND resolution.difference_type='packing'
           AND resolution.actual_quantity_snapshot=totals.cumulative_actual_quantity
           AND resolution.packing_revision_id=packing.packing_revision_id
           AND resolution.packing_quantity_snapshot=packing.packing_quantity
           AND resolution.difference_quantity_snapshot=packing.packing_quantity-totals.cumulative_actual_quantity
           AND COALESCE((SELECT event.after_state->>'quantityRevision' FROM operation_events event WHERE event.event_id=resolution.operation_event_id)=totals.actual_quantity_revision,
            totals.actual_quantity_changed_at IS NULL OR resolution.created_at>=totals.actual_quantity_changed_at)
         ORDER BY resolution.created_at DESC,resolution.resolution_id DESC
         LIMIT 1
       ) packing_resolution ON true
       LEFT JOIN app_users packing_resolution_user ON packing_resolution_user.id=packing_resolution.handled_by
       JOIN LATERAL (
         SELECT u.display_name
         FROM receiving_receipts latest
         JOIN receiving_batches latest_batch
           ON latest_batch.receiving_batch_id=latest.receiving_batch_id
          AND latest_batch.deleted_at IS NULL
         JOIN scoped_batches latest_scope
           ON latest_scope.receiving_batch_id=latest.receiving_batch_id
         JOIN app_users u ON u.id=latest.received_by
         WHERE latest_scope.group_key=totals.group_key
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
                   AND source_batch.group_key=totals.group_key
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
             WHERE scope.group_key=totals.group_key
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
                    'receivingBatchId',history.receiving_batch_id,
                    'batchVersion',history.batch_version,
                    'sequence',history.sequence,
                    'documentQuantity',totals.document_quantity,
                    'receiptDocumentQuantity',history.document_quantity,
                    'receivingSource',history.receiving_source,
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
           SELECT receipt.receipt_id,receipt.receiving_batch_id,
                  history_batch.version AS batch_version,
                  COALESCE(correction.document_quantity,receipt.document_quantity)::bigint AS document_quantity,
                  COALESCE(correction.receiving_source,receipt.receiving_source) AS receiving_source,
                  COALESCE(correction.actual_quantity,receipt.actual_quantity)::bigint AS actual_quantity,
                  COALESCE(correction.defective_quantity,receipt.defective_quantity)::bigint AS defective_quantity,
                  receipt.received_at,
                  users.display_name AS receiver_name,
                  row_number() OVER (
                    ORDER BY receipt.received_at,receipt.receipt_id
                  )::int AS sequence,
                  sum(COALESCE(correction.actual_quantity,receipt.actual_quantity)) OVER (
                    ORDER BY receipt.received_at,receipt.receipt_id
                    ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                  )::bigint AS cumulative_actual_quantity
           FROM receiving_receipts receipt
           JOIN receiving_batches history_batch
             ON history_batch.receiving_batch_id=receipt.receiving_batch_id
            AND history_batch.deleted_at IS NULL
           JOIN scoped_batches history_scope
             ON history_scope.receiving_batch_id=receipt.receiving_batch_id
           LEFT JOIN LATERAL (
             SELECT item.document_quantity,item.actual_quantity,item.defective_quantity,item.receiving_source
             FROM receiving_receipt_corrections item
             WHERE item.receipt_id=receipt.receipt_id
               AND (
                 $3::text<>''
                 OR item.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
               )
             ORDER BY item.created_at DESC,item.correction_id DESC
             LIMIT 1
           ) correction ON true
           JOIN app_users users ON users.id=receipt.received_by
           WHERE history_scope.group_key=totals.group_key
             AND (
               $3::text<>''
               OR receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
             )
         ) history
       ) receiving_history ON true
       ORDER BY totals.difference_rank ASC,totals.absolute_difference DESC,
                totals.last_received_at DESC,totals.style_key ASC,totals.group_key ASC`,
      pageWindowParameters,
    );
    const allRows: BoardRow[] = rowsResult.rows.map((row) => ({
      staleResolution: row.stale_resolution,
      resolutionHistory: row.resolution_history ?? [],
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
      packingRevisionId: row.packing_revision_id,
      packingQuantity: row.packing_quantity === null ? null : Number(row.packing_quantity),
      packingDifferenceQuantity: row.packing_quantity === null
        ? null
        : Number(row.packing_quantity) - Number(row.cumulative_actual_quantity),
      packingRecordedBy: row.packing_recorded_by,
      packingRecordedAt: row.packing_recorded_at?.toISOString() ?? null,
      actualCutCount: row.actual_cut_count == null ? null : Number(row.actual_cut_count),
      cuttingRecordedBy: row.cutting_recorded_by,
      cuttingRecordedAt: row.cutting_recorded_at?.toISOString() ?? null,
      receivingDifferenceResolution: row.receiving_resolution_id === null ? null : {
        resolutionId: row.receiving_resolution_id,
        result: row.receiving_resolution_result!,
        handledBy: row.receiving_resolution_handled_by!,
        handledAt: row.receiving_resolution_handled_at!.toISOString(),
        attachments: row.receiving_resolution_attachments,
      },
      packingDifferenceResolution: row.packing_resolution_id === null ? null : {
        resolutionId: row.packing_resolution_id,
        result: row.packing_resolution_result!,
        handledBy: row.packing_resolution_handled_by!,
        handledAt: row.packing_resolution_handled_at!.toISOString(),
        attachments: row.packing_resolution_attachments,
      },
      receiptCount: Number(row.receipt_count),
      batchCount: Number(row.batch_count),
      receivingHistory: row.receiving_history.map((item) => ({
        ...item,
        sequence: Number(item.sequence),
        documentQuantity: Number(item.documentQuantity),
        receiptDocumentQuantity: Number(item.receiptDocumentQuantity),
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
    const rows = allRows;
    const differenceQuantity = Number(summary.difference_quantity);
    const documentQuantity = Number(summary.document_quantity);
    const totalCount = Number(summary.order_count);
    if (target && totalCount === 0) fail("该收货批次不存在或尚无有效收货记录", 404, "NOT_FOUND");
      await client.query("COMMIT");
      return {
      date: endDate,
      startDate,
      endDate,
      mode,
      status,
      insights: { pendingCount: Number(summary.pending_count ?? 0), missingPackingCount: Number(summary.missing_packing_count ?? 0), staleCount: Number(summary.stale_count ?? 0) },
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
      page,
      pageSize,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / pageSize)),
      };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
