import type { PoolClient } from "pg";
import { receiptTime } from "./receiving-summary.js";

type ReceiptRow = {
  lineId: string;
  receiptId: string;
  batchId: string;
  receivedAt: Date;
  actualTime: Record<string,unknown> | null;
  documentQuantity: string;
  actualQuantity: string;
  defectiveQuantity: string;
};

// Use the native order receipt relation and the same effective correction as the receiving board.
export async function readCockpitOrderReceipts(db: PoolClient, orderId: string) {
  const { rows } = await db.query<ReceiptRow>(`
    SELECT relation.line_id AS "lineId", receipt.receipt_id AS "receiptId", batch.receiving_batch_id AS "batchId",
      receipt.received_at AS "receivedAt", event.after_state AS "actualTime",
      coalesce(correction.document_quantity,receipt.document_quantity) AS "documentQuantity",
      coalesce(correction.actual_quantity,receipt.actual_quantity) AS "actualQuantity",
      coalesce(correction.defective_quantity,receipt.defective_quantity) AS "defectiveQuantity"
    FROM digital_production_child_lines relation
    JOIN receiving_receipts receipt ON receipt.receipt_id=relation.child_id
    JOIN receiving_batches batch ON batch.receiving_batch_id=receipt.receiving_batch_id AND batch.deleted_at IS NULL
    JOIN operation_events event ON event.event_id=receipt.operation_event_id
    LEFT JOIN LATERAL (
      SELECT document_quantity,actual_quantity,defective_quantity FROM receiving_receipt_corrections change
      WHERE change.receipt_id=receipt.receipt_id ORDER BY change.created_at DESC,change.correction_id DESC LIMIT 1
    ) correction ON true
    WHERE relation.production_order_id=$1 AND relation.module='receiving'
    ORDER BY receipt.received_at,receipt.receipt_id`, [orderId]);
  return rows.map(({receivedAt,actualTime,...receipt}) => ({
    ...receipt,
    ...receiptTime(receivedAt,actualTime),
    documentQuantity: Number(receipt.documentQuantity),
    actualQuantity: Number(receipt.actualQuantity),
    defectiveQuantity: Number(receipt.defectiveQuantity),
  }));
}
