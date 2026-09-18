import { ReceivingAnalysisQuerySchema, ReceivingAnalysisResponseSchema } from "@dx-rework/contracts";
import type { Pool } from "pg";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { productionNotExcluded } from "../sourcing/production-visibility.js";

// Shared explicit receipt relationship for PR11/12. Never infer an order from a style/name.
// Batch-level adjustments cannot be assigned to individual production orders by guessing.
export const RECEIVING_ANALYSIS_LINKS_SQL = `SELECT receipt.receipt_id,receipt.receiving_batch_id,
 receipt.received_at,COALESCE(correction.actual_quantity,receipt.actual_quantity)::bigint AS actual_quantity,
 correction.correction_id,link.production_order_id,
 batch.deleted_at IS NOT NULL AS archived,
 EXISTS(SELECT 1 FROM sourcing_production_exclusions exclusion
   WHERE exclusion.production_order_id=link.production_order_id) AS excluded
 FROM receiving_receipts receipt JOIN receiving_batches batch USING(receiving_batch_id)
 LEFT JOIN sourcing_production_receipt_links link USING(receipt_id)
 LEFT JOIN LATERAL (SELECT item.actual_quantity,item.correction_id FROM receiving_receipt_corrections item
   WHERE item.receipt_id=receipt.receipt_id ORDER BY item.created_at DESC,item.correction_id DESC LIMIT 1) correction ON true`;

export async function readReceivingAnalysis(database: Pool, baseSql: string, actor: TrustedActorContext, input: unknown) {
  if (!actor.actorRoles.length) throw new ApplicationError("NO_BUSINESS_ROLE", "未分配业务角色", 403);
  const parsed = ReceivingAnalysisQuerySchema.safeParse(input);
  if (!parsed.success) throw new ApplicationError("VALIDATION_ERROR", "回货分析筛选无效", 400);
  const filters = parsed.data;
  const client = await database.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const facts = `${baseSql}, analysis_facts AS (
      SELECT totals.*,action.receiving_batch_id,action.version,
        packing.packing_revision_id,packing.packing_quantity,
        totals.cumulative_actual_quantity-totals.document_quantity AS receiving_difference,
        packing.packing_quantity-totals.cumulative_actual_quantity AS packing_difference,
        EXISTS(SELECT 1 FROM receiving_difference_resolutions resolution
          WHERE resolution.receiving_batch_id=action.receiving_batch_id AND resolution.difference_type='receiving'
            AND resolution.document_quantity_snapshot=totals.document_quantity
            AND resolution.actual_quantity_snapshot=totals.cumulative_actual_quantity
            AND resolution.difference_quantity_snapshot=totals.cumulative_actual_quantity-totals.document_quantity) AS receiving_handled,
        EXISTS(SELECT 1 FROM receiving_difference_resolutions resolution
          WHERE resolution.receiving_batch_id=action.receiving_batch_id AND resolution.difference_type='packing'
            AND resolution.actual_quantity_snapshot=totals.cumulative_actual_quantity
            AND resolution.packing_revision_id=packing.packing_revision_id
            AND resolution.packing_quantity_snapshot=packing.packing_quantity
            AND resolution.difference_quantity_snapshot=packing.packing_quantity-totals.cumulative_actual_quantity) AS packing_handled
      FROM style_totals totals
      JOIN LATERAL (SELECT batch.receiving_batch_id,batch.version FROM batch_totals batch
        WHERE batch.group_key=totals.group_key ORDER BY batch.last_through_end_received_at DESC NULLS LAST,
          batch.receiving_batch_id DESC LIMIT 1) action ON true
      LEFT JOIN LATERAL (SELECT revision.packing_revision_id,revision.packing_quantity FROM receiving_packing_revisions revision
        WHERE revision.receiving_batch_id=action.receiving_batch_id
        ORDER BY revision.created_at DESC,revision.packing_revision_id DESC LIMIT 1) packing ON true
    ), filtered AS (SELECT * FROM analysis_facts WHERE $4='all'
      OR ($4='receiving_difference' AND receiving_difference<>0)
      OR ($4='packing_difference' AND packing_difference<>0)
      OR ($4='missing_packing' AND packing_revision_id IS NULL)
      OR ($4='handled' AND (receiving_handled OR packing_handled)))`;
    const values = [filters.startDate, filters.endDate, filters.q.toUpperCase(), filters.fact];
    const summary = await client.query(`${facts}
      SELECT transaction_timestamp() AS as_of,count(*)::int AS "totalCount",
        COALESCE(sum(batch_count),0)::text AS "batchCount",
        COALESCE(sum(document_quantity),0)::text AS "documentQuantity",
        COALESCE(sum(cumulative_actual_quantity),0)::text AS "actualQuantity",
        COALESCE(sum(receiving_difference),0)::text AS "receivingDifference",
        COALESCE(sum(abs(receiving_difference)),0)::text AS "receivingAbsoluteDifference",
        sum(packing_quantity)::text AS "packingQuantity",sum(packing_difference)::text AS "packingDifference",
        count(*) FILTER(WHERE packing_revision_id IS NULL)::text AS "missingPackingCount",
        count(*) FILTER(WHERE receiving_handled OR packing_handled)::text AS "handledCount",
        (SELECT count(*)::text FROM receiving_receipts receipt
          JOIN scoped_batches batch USING(receiving_batch_id) JOIN filtered f ON f.group_key=batch.group_key
          LEFT JOIN sourcing_production_receipt_links link USING(receipt_id)
          WHERE link.receipt_id IS NULL AND ($3<>'' OR receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) AS "unlinkedReceiptCount",
        (SELECT count(*)::text FROM receiving_receipts receipt
          JOIN scoped_batches batch USING(receiving_batch_id) JOIN filtered f ON f.group_key=batch.group_key
          JOIN sourcing_production_receipt_links link USING(receipt_id)
          JOIN sourcing_production_exclusions exclusion USING(production_order_id)
          WHERE $3<>'' OR receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')) AS "excludedReceiptCount"
      FROM filtered`, values);
    const rows = await client.query(`${facts}, page_rows AS (
      SELECT * FROM filtered ORDER BY abs(receiving_difference) DESC,style_key,group_key,receiving_batch_id LIMIT 15 OFFSET $5)
      SELECT f.receiving_batch_id AS "receivingBatchId",f.style_key AS "styleNo",f.version,
        f.document_quantity::text AS "documentQuantity",f.cumulative_actual_quantity::text AS "actualQuantity",
        f.receiving_difference::text AS "receivingDifference",f.packing_revision_id AS "packingRevisionId",
        f.packing_quantity::text AS "packingQuantity",f.packing_difference::text AS "packingDifference",
        f.receiving_handled AS "receivingHandled",f.packing_handled AS "packingHandled",
        ARRAY(SELECT receiving_batch_id FROM scoped_batches WHERE group_key=f.group_key ORDER BY receiving_batch_id) AS "batchIds",
        COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'receiptId',receipt.receipt_id,'receivingBatchId',receipt.receiving_batch_id,'receivedAt',receipt.received_at,
          'documentQuantity',COALESCE(correction.document_quantity,receipt.document_quantity)::text,
          'actualQuantity',COALESCE(correction.actual_quantity,receipt.actual_quantity)::text,'correctionId',correction.correction_id,
          'productionOrderId',production.production_order_id,'supplierId',production.supplier_id,
          'supplierName',production.supplier_name_snapshot,'contractNumber',production.contract_number,
          'excluded',link.production_order_id IS NOT NULL AND production.production_order_id IS NULL,
          'attachments',COALESCE((SELECT jsonb_agg(jsonb_build_object('attachmentId',attachment.attachment_id,'filename',attachment.original_filename))
            FROM attachments attachment WHERE attachment.entity_type='receiving_batch'
              AND attachment.entity_id=receipt.receiving_batch_id::text AND attachment.status='ready'
              AND attachment.mime_type LIKE 'image/%' AND NOT EXISTS(SELECT 1 FROM receiving_attachment_retirements retired
                WHERE retired.attachment_id=attachment.attachment_id)),'[]'::jsonb)
          ) ORDER BY receipt.received_at,receipt.receipt_id)
          FROM receiving_receipts receipt JOIN scoped_batches batch USING(receiving_batch_id)
          LEFT JOIN LATERAL (SELECT item.correction_id,item.actual_quantity,item.document_quantity
            FROM receiving_receipt_corrections item WHERE item.receipt_id=receipt.receipt_id
              AND ($3<>'' OR item.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))
            ORDER BY item.created_at DESC,item.correction_id DESC LIMIT 1) correction ON true
          LEFT JOIN sourcing_production_receipt_links link USING(receipt_id)
          LEFT JOIN sourcing_production_orders production ON production.production_order_id=link.production_order_id AND ${productionNotExcluded}
          WHERE batch.group_key=f.group_key AND ($3<>'' OR receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))),'[]'::jsonb) AS receipts,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('revisionId',revision.packing_revision_id,
          'receivingBatchId',revision.receiving_batch_id,'quantity',revision.packing_quantity::text,'recordedAt',revision.created_at)
          ORDER BY revision.created_at DESC,revision.packing_revision_id DESC)
          FROM receiving_packing_revisions revision JOIN scoped_batches batch USING(receiving_batch_id)
          WHERE batch.group_key=f.group_key),'[]'::jsonb) AS "packingHistory",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('resolutionId',resolution.resolution_id,
          'receivingBatchId',resolution.receiving_batch_id,'type',resolution.difference_type,
          'documentQuantity',resolution.document_quantity_snapshot::text,'actualQuantity',resolution.actual_quantity_snapshot::text,
          'packingQuantity',resolution.packing_quantity_snapshot::text,'differenceQuantity',resolution.difference_quantity_snapshot::text,
          'packingRevisionId',resolution.packing_revision_id,'result',resolution.result,'handledAt',resolution.created_at)
          ORDER BY resolution.created_at DESC,resolution.resolution_id DESC)
          FROM receiving_difference_resolutions resolution JOIN scoped_batches batch USING(receiving_batch_id)
          WHERE batch.group_key=f.group_key),'[]'::jsonb) AS resolutions
      FROM page_rows f ORDER BY abs(f.receiving_difference) DESC,f.style_key,f.group_key,f.receiving_batch_id`, [...values, (filters.page - 1) * 15]);
    const {as_of: asOf, ...totals} = summary.rows[0]!;
    const response = ReceivingAnalysisResponseSchema.parse({asOf: new Date(asOf).toISOString(), filters, summary: totals, items: rows.rows});
    await client.query("COMMIT");
    return response;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
