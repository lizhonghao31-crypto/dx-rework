import type { PoolClient } from "pg";
import { receiptTime } from "./receiving-summary.js";

type ReceiptScope = { lineId: string; cutIds: string[]; factories: { productionId: string; factoryDecisionId: string | null }[] };
type ReceiptRow = {
  lineId: string;
  receiptId: string;
  batchId: string;
  cutId: string | null;
  receivedAt: Date;
  actualTime: Record<string,unknown> | null;
  documentQuantity: string;
  actualQuantity: string;
  defectiveQuantity: string;
};

// Project only effective receipts independently proved to belong to a visible
// PO. An unproven factory origin cannot enlarge a partial permission scope.
export async function readCockpitScopedReceipts(db: PoolClient, orderId: string, complete: boolean, scope: readonly ReceiptScope[]) {
  const { rows } = await db.query<ReceiptRow>(`
    WITH allowed AS (
      SELECT * FROM jsonb_to_recordset($2::jsonb) AS line("lineId" uuid,"cutIds" jsonb,factories jsonb)
    )
    SELECT relation.line_id AS "lineId", receipt.receipt_id AS "receiptId", batch.receiving_batch_id AS "batchId",
      batch.cutting_order_id AS "cutId", receipt.received_at AS "receivedAt", event.after_state AS "actualTime",
      coalesce(correction.document_quantity,receipt.document_quantity) AS "documentQuantity",
      coalesce(correction.actual_quantity,receipt.actual_quantity) AS "actualQuantity",
      coalesce(correction.defective_quantity,receipt.defective_quantity) AS "defectiveQuantity"
    FROM allowed JOIN digital_production_child_lines relation
      ON relation.production_order_id=$1 AND relation.module='receiving' AND relation.line_id=allowed."lineId"
    JOIN receiving_receipts receipt ON receipt.receipt_id=relation.child_id
    JOIN receiving_batches batch ON batch.receiving_batch_id=receipt.receiving_batch_id AND batch.deleted_at IS NULL
    JOIN operation_events event ON event.event_id=receipt.operation_event_id
    LEFT JOIN sourcing_production_receipt_links origin ON origin.receipt_id=receipt.receipt_id
    LEFT JOIN LATERAL (
      SELECT document_quantity,actual_quantity,defective_quantity FROM receiving_receipt_corrections change
      WHERE change.receipt_id=receipt.receipt_id ORDER BY change.created_at DESC,change.correction_id DESC LIMIT 1
    ) correction ON true
    WHERE $3::boolean OR (batch.cutting_order_id::text IN (SELECT jsonb_array_elements_text(allowed."cutIds")) AND EXISTS (
      SELECT 1 FROM jsonb_to_recordset(allowed.factories) AS factory("productionId" uuid,"factoryDecisionId" uuid)
      WHERE origin.production_order_id=factory."productionId"
        AND origin.factory_decision_id IS NOT DISTINCT FROM factory."factoryDecisionId"
    ))
    ORDER BY receipt.received_at,receipt.receipt_id`, [orderId, JSON.stringify(scope), complete]);
  return rows.map(({receivedAt,actualTime,...receipt}) => ({
    ...receipt,
    ...receiptTime(receivedAt,actualTime),
    documentQuantity: Number(receipt.documentQuantity),
    actualQuantity: Number(receipt.actualQuantity),
    defectiveQuantity: Number(receipt.defectiveQuantity),
  }));
}

// The original history expands the entire cut group. A single visible batch
// never confers permission to read that group or its combined documents.
export async function authorizedReceivingHistoryBatches(db: PoolClient, receipts: ReadonlyArray<{ receiptId: string; batchId: string; cutId: string | null }>) {
  if (!receipts.length) return [];
  return (await db.query<{ batchId: string }>(`
    WITH allowed AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS proof("receiptId" uuid,"batchId" uuid,"cutId" uuid)
    ), candidate_batches AS (
      SELECT DISTINCT item."batchId" FROM allowed item
      UNION
      SELECT sibling.receiving_batch_id FROM allowed item
      JOIN receiving_batches sibling ON sibling.cutting_order_id=item."cutId" AND sibling.deleted_at IS NULL
    ), qualified_batches AS (
      SELECT candidate."batchId" FROM candidate_batches candidate
      WHERE NOT EXISTS (
        SELECT 1 FROM receiving_receipts actual
        WHERE actual.receiving_batch_id=candidate."batchId"
          AND NOT EXISTS (SELECT 1 FROM allowed item WHERE item."receiptId"=actual.receipt_id
            AND item."batchId"=actual.receiving_batch_id)
      ) AND EXISTS(SELECT 1 FROM allowed item WHERE item."batchId"=candidate."batchId")
      AND NOT EXISTS(
        SELECT 1 FROM receiving_receipt_corrections correction
        WHERE correction.receiving_batch_id=candidate."batchId"
          AND NOT EXISTS(SELECT 1 FROM allowed item WHERE item."receiptId"=correction.receipt_id)
      )
      AND NOT EXISTS(
        SELECT 1 FROM operation_events merge WHERE merge.entity_type='receiving_batch'
          AND merge.action='receiving.batch.merge' AND merge.entity_id=candidate."batchId"::text
          AND (merge.after_state->>'sourceReceivingBatchId' IS NULL
            OR NOT EXISTS(SELECT 1 FROM receiving_receipt_corrections correction
              JOIN allowed item ON item."receiptId"=correction.receipt_id
              WHERE correction.operation_event_id=merge.event_id
                AND correction.receiving_batch_id::text=merge.after_state->>'sourceReceivingBatchId'))
      )
    )
    SELECT "batchId" FROM qualified_batches ORDER BY 1`, [JSON.stringify(receipts)])).rows.map(row=>row.batchId);
}
