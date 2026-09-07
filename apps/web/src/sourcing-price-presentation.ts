import { SourcingNewUnitPriceSchema, type SourcingCaseSummary } from "@dx-rework/contracts";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";

export const isNewSourcingPrice = (value: string): boolean => SourcingNewUnitPriceSchema.safeParse(value).success;

export const newSourcingPriceDisplay = (value: string): string =>
  isNewSourcingPrice(value) ? formatBusinessDecimal(value) : value;

export function sourcingPriceSummary(pricing: Readonly<{
  unitPrice: string;
  sourceType?: string;
  linePrices: readonly Readonly<{ unitPrice: string }>[];
}> | null): string {
  if (!pricing) return "—";
  if (pricing.sourceType === "factory_change") return formatBusinessCurrency(pricing.unitPrice);
  if (pricing.linePrices.length > 1) return "多款价 · 见逐款明细";
  return formatBusinessCurrency(pricing.linePrices[0]?.unitPrice ?? pricing.unitPrice);
}

export function sourcingDeleteConfirmation(item: SourcingCaseSummary): string {
  const styles = item.lineItems.map((line) => `${line.styleNo} / ${line.color ?? "历史未维护颜色"}`).join("、");
  return `确认删除此外发订单？\n款色：${styles}\n供应商：${item.decision?.supplierName ?? "尚未选厂"}\n数量：${formatBusinessDecimal(item.orderQuantity)} 件\n订单号：${item.erpOrderNo}\n删除后从外发业务入口隐藏并关闭相关待办，历史证据保留。关联生产单不会自动作为测试记录排除，需单独核对。\n辅助标识：${item.sourcingCaseId}`;
}
