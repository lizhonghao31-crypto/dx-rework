type ReceivingSource = Readonly<{ styleNo: string; cuttingOrderId?: string }>;

/** Explicit cutting sources stay distinct; legacy input retains style grouping. */
export function hasExistingReceivingSource(
  orders: readonly ReceivingSource[],
  styleNo: string,
  cuttingOrderId?: string,
): boolean {
  return orders.some(order => cuttingOrderId
    ? order.cuttingOrderId === cuttingOrderId
    : order.styleNo.trim().toUpperCase() === styleNo.trim().toUpperCase());
}
