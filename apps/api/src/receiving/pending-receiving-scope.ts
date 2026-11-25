/** X4's quantity projection has no write path. Its caller must first authorize
 * the original allocation and read effective receipts in the same snapshot. */
export type PendingReceivingIdentity = Readonly<{
  orderId: string;
  productionId: string;
  // Verified stable allocation key. The original factory can have a null raw
  // decision ID; only a proven original allocation may supply a key for it.
  factoryAllocationKey: string;
  lineId: string;
  cuttingOrderId: string;
}>;

type Dispatch = Readonly<{
  factId: string;
  identity: PendingReceivingIdentity;
  kind: string;
  actualDispatchedAt: string;
  dispatchedQuantity: number;
}>;

export type PendingReceivingReceipt = Readonly<{
  receiptId: string;
  quantityVersion: string;
  identity: { [K in keyof PendingReceivingIdentity]: string | null };
  actualQuantity: number;
}>;
type Receipt=PendingReceivingReceipt;

const dimensions = ["orderId", "productionId", "factoryAllocationKey", "lineId", "cuttingOrderId"] as const;
const quantity = (value: number) => Number.isSafeInteger(value) && value >= 0;
const instant = (value: string) => /T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
const sameScope = (left: PendingReceivingIdentity, right: Receipt["identity"]) => dimensions.every(key => left[key] === right[key]);
const possibleScope = (left: PendingReceivingIdentity, right: Receipt["identity"]) => right.orderId === left.orderId
  && dimensions.every(key => right[key] === null || right[key] === left[key]);
const receiptFingerprint = (row: Receipt) => JSON.stringify([row.quantityVersion, row.actualQuantity, ...dimensions.map(key => row.identity[key])]);

/** Allocation balances cannot be attributed to an individual dispatch unless
 * the native receipt proves that dispatch. Return only the proven aggregate;
 * the fact references identify physical shipments, not invented FIFO balances. */
export function projectPendingReceivingScope(input: Readonly<{
  identity: PendingReceivingIdentity;
  expectedQuantity: number | null;
  dispatches: readonly Dispatch[];
  effectiveReceipts: readonly Receipt[];
}>) {
  const { identity, expectedQuantity, dispatches, effectiveReceipts } = input;
  if (dimensions.some(key => !identity[key].trim())) return null;
  const confirmed = new Map<string, {actualDispatchedAt:string;dispatchedQuantity:number}>();
  let dispatchConflict = false;
  for (const fact of dispatches) {
    if (fact.kind !== "仓库实际发厂" || !sameScope(identity, fact.identity) || !fact.factId || !instant(fact.actualDispatchedAt)) continue;
    if (!quantity(fact.dispatchedQuantity) || fact.dispatchedQuantity === 0) {
      dispatchConflict = true;
      continue;
    }
    const prior = confirmed.get(fact.factId);
    if (prior && (Date.parse(prior.actualDispatchedAt) !== Date.parse(fact.actualDispatchedAt) ||
        prior.dispatchedQuantity !== fact.dispatchedQuantity)) dispatchConflict = true;
    else confirmed.set(fact.factId, {actualDispatchedAt:fact.actualDispatchedAt,dispatchedQuantity:fact.dispatchedQuantity});
  }
  if (!confirmed.size || expectedQuantity === 0) return null;
  const shipments = [...confirmed].map(([factId, fact])=>({factId,...fact}));
  const dispatched = shipments.reduce((sum,row)=>sum+row.dispatchedQuantity,0);
  const verifiedDispatched = !dispatchConflict&&Number.isSafeInteger(dispatched)?dispatched:null;

  const uniqueReceipts = new Map<string, Receipt>();
  const collisions = new Set<string>();
  for (const row of effectiveReceipts) {
    const prior = uniqueReceipts.get(row.receiptId);
    if (prior && receiptFingerprint(prior) !== receiptFingerprint(row)) collisions.add(row.receiptId);
    else uniqueReceipts.set(row.receiptId, row);
  }
  const matched = [...uniqueReceipts.values()].filter(row => sameScope(identity, row.identity));
  const unresolved = verifiedDispatched === null || expectedQuantity === null || !quantity(expectedQuantity)
    || effectiveReceipts.some(row => possibleScope(identity, row.identity) && (
      !quantity(row.actualQuantity) || collisions.has(row.receiptId)
      || row.actualQuantity > 0 && (!row.receiptId || !row.quantityVersion || !sameScope(identity, row.identity))
    ));
  const receipts = matched.filter(row => row.receiptId && row.quantityVersion && quantity(row.actualQuantity) && !collisions.has(row.receiptId));
  const received = receipts.reduce((sum, row) => sum + row.actualQuantity, 0);
  if (unresolved || !Number.isSafeInteger(received)) return {
    dispatches: shipments, actualDispatched:verifiedDispatched, receipts, status: "unresolved" as const, received: null,
    provenReceived: Number.isSafeInteger(received) ? received : null,
    remaining: null, difference: null,
  };

  const difference = received - expectedQuantity!;
  return {
    dispatches: shipments, actualDispatched:verifiedDispatched, receipts, status: difference > 0 ? "over_received" as const : difference === 0 ? "collected" as const : "pending" as const,
    received, provenReceived: received, remaining: Math.max(0, -difference), difference,
  };
}
