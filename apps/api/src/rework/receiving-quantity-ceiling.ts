import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";

type QueryClient = Pick<Pool, "query"> | Pick<PoolClient, "query">;
type QuantityFact = Readonly<{ label: string; quantity: number }>;

export const sourceReceivingQuantityCeilingError = (cause: unknown): ApplicationError | null => {
  if (!cause || typeof cause !== "object") return null;
  const failure = cause as { code?: unknown; message?: unknown };
  if (failure.code !== "23514" || typeof failure.message !== "string") return null;
  const match = /^rework quantity exceeds source receiving actual quantity ceiling (\d+(?:\.\d+)?)$/.exec(failure.message);
  return match ? new ApplicationError("VALIDATION_ERROR", `确认数量不能超过本次实收数量 ${Number(match[1])} 件，请刷新报数后重试`, 400) : null;
};

export const sourceReceivingActualQuantity = async (
  client: QueryClient,
  reworkOrderId: string,
): Promise<number | null> => {
  const result = await client.query<{ quantity: string | null }>(
    `SELECT CASE WHEN orders.source_receiving_batch_id IS NULL THEN NULL
              ELSE COALESCE(receiving.actual_quantity,0)::text
            END AS quantity
     FROM rework_orders orders
     LEFT JOIN LATERAL (
       SELECT (COALESCE(sum(receipt.actual_quantity),0)+batch.actual_quantity_adjustment)::bigint actual_quantity
       FROM receiving_batches batch
       LEFT JOIN receiving_receipts receipt
         ON receipt.receiving_batch_id=batch.receiving_batch_id
       WHERE batch.receiving_batch_id=orders.source_receiving_batch_id
       GROUP BY batch.receiving_batch_id
     ) receiving ON true
     WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'`,
    [reworkOrderId],
  );
  const quantity = result.rows[0]?.quantity ?? null;
  return quantity === null ? null : Number(quantity);
};

export const ensureWithinSourceReceivingActualQuantity = async (
  client: QueryClient,
  reworkOrderId: string,
  facts: readonly QuantityFact[],
): Promise<void> => {
  const ceiling = await sourceReceivingActualQuantity(client, reworkOrderId);
  if (ceiling === null) return;
  const exceeded = facts.find((fact) => fact.quantity > ceiling);
  if (exceeded) {
    throw new ApplicationError(
      "VALIDATION_ERROR",
      `${exceeded.label}不能超过本次实收数量 ${ceiling} 件`,
      400,
    );
  }
};
