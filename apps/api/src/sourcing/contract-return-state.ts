export type ContractReturnStatus = "pending" | "returned_on_time" | "overdue_pending" | "returned_late";
export type ContractReturnFilter = "all" | ContractReturnStatus | "all_overdue";

export type ContractReturnFacts = {
  contract_return_monitor_enabled: boolean;
  contract_return_catchup?: boolean | null;
  contract_generated_at: Date | string | null;
  contract_return_due_at: Date | string | null;
  contract_returned_at: Date | string | null;
  // Calculated in SQL using the same Shanghai calendar rule as the deadline.
  contract_return_overdue_seconds: number | string | null;
  time_quality?: 'business_projection'|'legacy_audit'|'unknown'|'not_applicable'|undefined;
  time_reason?: string | null;
};

// An approved order is eligible even while its PDF is pending.
export function contractReturnState(facts: ContractReturnFacts, asOf: Date | string): {
  contractReturnMonitoring: boolean;
  contractReturnStatus: ContractReturnStatus | null;
  contractGeneratedAt: string | null;
  contractReturnDueAt: string | null;
  contractReturnedAt: string | null;
  contractReturnOverdueHours: number | null;
  contractReturnTimeQuality?: ContractReturnFacts['time_quality'];
  contractReturnTimeReason?: string | null;
  contractReturnAsOf?: string;
} {
  const iso = (date: Date | string | null) => date === null ? null : new Date(date).toISOString();
  if (!facts.contract_return_monitor_enabled) {
    return {
      contractReturnMonitoring: false,contractReturnStatus: null,contractGeneratedAt: null,
      contractReturnDueAt: null,contractReturnedAt: null,contractReturnOverdueHours: null,
    };
  }
  // Approval sets eligibility. The first ready PDF starts the separate 48-hour clock.
  const clockReady = !!facts.contract_generated_at && !!facts.contract_return_due_at;
  const due = clockReady ? new Date(facts.contract_return_due_at!).getTime() : null;
  const returned = facts.contract_returned_at === null ? null : new Date(facts.contract_returned_at).getTime();
  const status: ContractReturnStatus = returned !== null
    ? due === null || returned <= due ? "returned_on_time" : "returned_late"
    : due === null || new Date(asOf).getTime() <= due ? "pending" : "overdue_pending";
  return {
    ...(facts.time_quality && facts.time_quality!=="legacy_audit" ? {contractReturnTimeQuality:facts.time_quality,contractReturnTimeReason:facts.time_reason??null,contractReturnAsOf:new Date(asOf).toISOString()} : {}),
    contractReturnMonitoring: true,contractReturnStatus: facts.time_quality==='unknown'?null:status,
    contractGeneratedAt: iso(facts.contract_generated_at),
    contractReturnDueAt: iso(facts.contract_return_due_at),
    contractReturnedAt: iso(facts.contract_returned_at),
    contractReturnOverdueHours: !clockReady || facts.time_quality==='unknown' ? null
      : status === "returned_late" || status === "overdue_pending"
        ? Math.max(0, Math.floor(Number(facts.contract_return_overdue_seconds ?? 0) / 3600)) : 0,
  };
}
