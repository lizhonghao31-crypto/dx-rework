import type { ProductionReceivingSummary } from "@dx-rework/contracts";
type Page = { items: ProductionReceivingSummary[]; page: number; totalCount: number };
export const factoryReceiptKey = (item: ProductionReceivingSummary) => `${item.productionOrderId}:${item.factoryDecisionId ?? "original"}`;
/** Read every page from the same authorized cutting-order scope before exposing choices. */
export async function loadFactoryReceiptOptions(readPage: (page: number) => Promise<Page>, signal: AbortSignal): Promise<ProductionReceivingSummary[]> {
  const items: ProductionReceivingSummary[] = [];
  let expected: number | undefined;
  for (let page = 1; ; page++) {
    signal.throwIfAborted();
    const result = await readPage(page);
    signal.throwIfAborted();
    expected ??= result.totalCount;
    if (result.page !== page || result.totalCount !== expected || (items.length < expected && result.items.length === 0)) throw new Error("加工厂候选已变化，请重新打开收货页面");
    items.push(...result.items);
    if (items.length >= expected) break;
  }
  if (items.length !== expected || new Set(items.map(factoryReceiptKey)).size !== expected) throw new Error("加工厂候选已变化，请重新打开收货页面");
  return items;
}
