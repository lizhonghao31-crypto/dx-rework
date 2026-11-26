import type { PoolClient } from "pg";

/** The caller owns the locked, audited receiving correction transaction. */
export async function correctSourceBatchStyle(
  client: PoolClient,
  receivingBatchId: string,
  styleNo: string,
  actorId: string,
): Promise<void> {
  await client.query(
    `UPDATE rework_orders
     SET style_no=$2,version=version+1,updated_by=$3,updated_at=clock_timestamp()
     WHERE source_receiving_batch_id=$1 AND style_no IS DISTINCT FROM $2`,
    [receivingBatchId, styleNo, actorId],
  );
}
