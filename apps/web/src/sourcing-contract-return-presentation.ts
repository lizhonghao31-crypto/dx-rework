import type { SourcingCaseSummary, SourcingContractReturnResponse } from "@dx-rework/contracts";

export function sourcingContractReturnLabel(
  state: Pick<SourcingContractReturnResponse,"contractReturnStatus"|"contractReturnOverdueHours">,
): string {
  const hours=state.contractReturnOverdueHours;
  const suffix=hours === null ? "" : hours < 1 ? "<1 小时" : `${hours} 小时`;
  switch(state.contractReturnStatus) {
    case "pending": return "合同待回签";
    case "returned_on_time": return "合同已回签";
    case "overdue_pending": return `逾期 ${suffix}`;
    case "returned_late": return `逾期回签 ${suffix}`;
    default: return "";
  }
}

// One short badge beside the style number; details retain the full wording.
export function sourcingContractReturnBadgeLabel(
  state: Pick<SourcingCaseSummary,"contractReturnStatus"|"contractReturnOverdueHours">,
): string | null {
  const hours=state.contractReturnOverdueHours;
  const elapsed=hours == null || hours < 1 ? "<1 小时" : `${hours} 小时`;
  switch(state.contractReturnStatus) {
    case "pending": return "待回签";
    case "returned_on_time": return "已回签";
    case "overdue_pending": return `逾期 ${elapsed}`;
    case "returned_late": return `逾期回签 ${elapsed}`;
    default: return null;
  }
}
