import { poDateSummary, type SourcingCaseSummary } from "@dx-rework/contracts";
import { customerPoDateLabel } from "./digital-workspace-copy.js";

function DateValue({ value }: { value: string }) {
  return <>{value.split(/(\d{4}-\d{2}-\d{2})/).map((part, index) => /^\d{4}-\d{2}-\d{2}$/.test(part)
    ? <span className="sourcing-date-token" key={index}>{part}</span> : part)}</>;
}

/** Each date keeps its existing meaning and snapshot source; no current data fills historical gaps. */
export function SourcingOrderDateFacts({item,historical=false,approvalProposedDate}:{
  item:Pick<SourcingCaseSummary,"lineItems"|"deliveryDate">;historical?:boolean;approvalProposedDate?:string|null;
}) {
  const hasPoDates = item.lineItems.length > 0 && item.lineItems.every(line => Boolean(line.lineId));
  const customerDates = item.lineItems.map(line => line.customerWarehouseArrivalDate);
  const providedHistory = customerDates.filter((date): date is string | null => date !== undefined);
  const unavailableHistory = historical ? customerDates.length - providedHistory.length : 0;
  const customer = !hasPoDates ? "历史未维护" : unavailableHistory
    ? [providedHistory.length ? poDateSummary(providedHistory) : null,
      `当时日期不详${providedHistory.length ? `（${unavailableHistory}/${customerDates.length}）` : ""}`].filter(Boolean).join(" · ")
    : poDateSummary(customerDates.map(date => date ?? null));
  const factory = hasPoDates ? poDateSummary(item.lineItems.map(line => line.factoryDeliveryDate ?? null)) : item.deliveryDate ?? "历史未维护";
  return <>
    <div className="sourcing-key-facts__date"><dt>PO / {customerPoDateLabel}</dt><dd><DateValue value={customer} /></dd></div>
    <div className="sourcing-key-facts__date"><dt>{hasPoDates ? "加工厂交货日" : "要求交货日期"}</dt><dd><DateValue value={factory} />
      {approvalProposedDate?<small>审批提议：<DateValue value={approvalProposedDate} /></small>:null}
      {historical && hasPoDates && item.deliveryDate && !item.lineItems.every(line => line.factoryDeliveryDate === item.deliveryDate)
        ? <small>当时要求交货：<DateValue value={item.deliveryDate} /></small> : null}
    </dd></div>
  </>;
}
