import type { SourcingCaseSummary } from "@dx-rework/contracts";
import { sourcingLinePricing } from "./sourcing-price-presentation.js";

const businessDate = (edited: string | undefined, fallback: string | null) => {
  if (!edited || !/^\d{4}-\d{2}-\d{2}$/.test(edited) || edited.startsWith("0000-")) return fallback;
  const value = new Date(`${edited}T00:00:00Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0,10) === edited ? edited : fallback;
};

// Presentation only. Business actions keep the original order/decision/approval basis.
export function sourcingCurrentDisplay(item: SourcingCaseSummary) {
  const contract = item.contractDisplay;
  const lines = contract?.linesMatchOrder ? item.lineItems.map(line => {
    const edited = contract.lines.find(row => row.position === line.position)!;
    return { ...line, styleNo: edited.styleNo, alternateStyleNo: edited.alternateStyleNo,
      color: edited.color, quantity: edited.quantity, imageAttachmentId: edited.imageAttachmentId };
  }) : item.lineItems;
  return {
    styleNo: lines[0]?.styleNo ?? item.styleNo,
    gender: contract?.gender ?? item.gender, styleName: contract?.styleName ?? item.styleName,
    supplierName: contract?.partyBName ?? item.decision?.supplierName,
    quantity: contract?.totalQuantity ?? item.orderQuantity,
    totalAmount: contract?.totalAmount ?? item.decision?.totalAmount,
    estimatedCutPieceSendDate: businessDate(contract?.estimatedCutPieceSendDate,item.estimatedCutPieceSendDate),
    deliveryDate: businessDate(contract?.deliveryDate,item.deliveryDate),
    processes: contract?.processes ?? item.processes, lines,
    prices: contract?.linesMatchOrder ? contract.lines : item.lineItems.flatMap(line => {
      const price = sourcingLinePricing(item.decision,line.position,item.lineItems.length);
      return price ? [{position:line.position,...price}] : [];
    }),
  };
}
