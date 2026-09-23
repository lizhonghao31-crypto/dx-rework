import type { SourcingContractReturnResponse } from "@dx-rework/contracts";

export function sourcingContractReturnLabel(
  state: Pick<SourcingContractReturnResponse,"contractReturnStatus"|"contractReturnOverdueHours">,
): string {
  const hours=state.contractReturnOverdueHours;
  const suffix=hours === null ? "" : hours < 1 ? "<1 小时" : `${hours} 小时`;
  switch(state.contractReturnStatus) {
    case "pending": return "合同待回签";
    case "returned_on_time": return "合同已回签";
    case "overdue_pending": return `合同回传逾期 ${suffix}`;
    case "returned_late": return `合同已回传，逾期 ${suffix}`;
    default: return "";
  }
}
