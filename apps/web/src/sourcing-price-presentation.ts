import { calculateSourcingLinesTotalExact, SourcingNewUnitPriceSchema, type SourcingCaseSummary } from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";

export const isNewSourcingPrice = (value: string): boolean => SourcingNewUnitPriceSchema.safeParse(value).success;

export const newSourcingPriceDisplay = (value: string): string =>
  isNewSourcingPrice(value) ? formatBusinessDecimal(value) : value;

/** Factory changes retain their existing four-place price, rounding each remaining line to cents. */
export function factoryChangeTotalPreview(unitPrice: string, quantities: readonly number[]): string {
  try {
    return calculateSourcingLinesTotalExact(quantities.map(quantity=>({unitPrice,quantity})));
  } catch {
    return "—";
  }
}

/** Presentation-only hint; authoritative validation remains in the existing service. */
export function sourcingDecisionNeedsReason(current: readonly { position: number; unitPrice: string }[], quoted: readonly { position: number; unitPrice: string }[]): boolean {
  const exact = (price: string): bigint | null => {
    const match = /^(\d{1,10})(?:\.(\d{1,4}))?$/.exec(price.trim());
    return match ? BigInt(match[1]!) * 10_000n + BigInt((match[2] ?? "").padEnd(4, "0")) : null;
  };
  return current.some(line => {
    if (!isNewSourcingPrice(line.unitPrice)) return false; // Existing price feedback handles invalid input.
    const previous = quoted.find(value => value.position === line.position);
    const prior = previous ? exact(previous.unitPrice) : null;
    const next = exact(line.unitPrice);
    return prior !== null && next !== null && next > prior;
  });
}

export function historicalSourcingPrice(value: string): string {
  const matched = /^(\d+)(?:\.(\d{1,4}))?$/.exec(value);
  if (!matched) return formatBusinessCurrency(value);
  const fraction = (matched[2] ?? "").replace(/0+$/, "");
  return `¥${matched[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}${fraction ? `.${fraction}` : ""}`;
}

export function sourcingPriceSummary(pricing: Readonly<{
  unitPrice: string;
  sourceType?: string;
  linePrices: readonly Readonly<{ unitPrice: string }>[];
}> | null): string {
  if (!pricing) return "—";
  if (pricing.sourceType === "factory_change") return formatBusinessCurrency(pricing.unitPrice);
  if (pricing.linePrices.length > 1) return "多款价 · 见逐款明细";
  return historicalSourcingPrice(pricing.linePrices[0]?.unitPrice ?? pricing.unitPrice);
}

/** Prefer authoritative lines belonging to this decision; fall back only for legacy gaps. */
export function sourcingLinePricing(pricing: Readonly<{
  unitPrice: string;
  totalAmount: string;
  sourceType?: string;
  linePrices: readonly Readonly<{ position: number; unitPrice: string; totalAmount: string }>[];
}> | null, position: number, lineCount: number): { unitPrice: string; totalAmount: string | null } | null {
  if (!pricing) return null;
  const line = pricing.linePrices.find(entry => entry.position === position);
  if (line) return { unitPrice: line.unitPrice, totalAmount: line.totalAmount };
  if (pricing.sourceType === "factory_change") {
    return { unitPrice: pricing.unitPrice, totalAmount: lineCount === 1 ? pricing.totalAmount : null };
  }
  // A legacy single-line order can use the original order-level facts unambiguously.
  return lineCount === 1 ? { unitPrice: pricing.unitPrice, totalAmount: pricing.totalAmount } : null;
}

export function sourcingDeleteConfirmation(item: SourcingCaseSummary): string {
  const styles = item.lineItems.map((line) => `${line.styleNo} / ${line.color ?? "历史未维护颜色"}`).join("、");
  return `确认删除此外发订单？\n款色：${styles}\n供应商：${item.decision?.supplierName ?? "尚未选厂"}\n数量：${formatBusinessDecimal(item.orderQuantity)} 件\n订单号：${item.erpOrderNo}\n删除后从外发业务入口隐藏并关闭相关待办，历史证据保留。关联生产单不会自动作为测试记录排除，需单独核对。\n辅助标识：${item.sourcingCaseId}`;
}
