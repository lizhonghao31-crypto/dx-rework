export type ContractReturnStatus = "pending" | "returned_on_time" | "overdue_pending" | "returned_late";
export type ContractReturnFilter = "all" | ContractReturnStatus | "all_overdue";

export type ContractReturnFacts = {
  contract_return_monitor_enabled: boolean;
  contract_generated_at: Date | string | null;
  contract_return_due_at: Date | string | null;
  contract_returned_at: Date | string | null;
  // Calculated in SQL using the same Shanghai calendar rule as the deadline.
  contract_return_overdue_seconds: number | string | null;
};

// A pending contract has no clock and is intentionally absent from the monitored list.
export function contractReturnState(facts: ContractReturnFacts, asOf: Date | string): {
  contractReturnMonitoring: boolean;
  contractReturnStatus: ContractReturnStatus | null;
  contractGeneratedAt: string | null;
  contractReturnDueAt: string | null;
  contractReturnedAt: string | null;
  contractReturnOverdueHours: number | null;
} {
  const iso = (date: Date | string | null) => date === null ? null : new Date(date).toISOString();
  if (!facts.contract_return_monitor_enabled || !facts.contract_generated_at || !facts.contract_return_due_at) {
    return {
      contractReturnMonitoring: false,contractReturnStatus: null,contractGeneratedAt: null,
      contractReturnDueAt: null,contractReturnedAt: null,contractReturnOverdueHours: null,
    };
  }
  const due = new Date(facts.contract_return_due_at).getTime();
  const returned = facts.contract_returned_at === null ? null : new Date(facts.contract_returned_at).getTime();
  const status: ContractReturnStatus = returned !== null
    ? returned <= due ? "returned_on_time" : "returned_late"
    : new Date(asOf).getTime() <= due ? "pending" : "overdue_pending";
  return {
    contractReturnMonitoring: true,contractReturnStatus: status,
    contractGeneratedAt: iso(facts.contract_generated_at),
    contractReturnDueAt: iso(facts.contract_return_due_at),
    contractReturnedAt: iso(facts.contract_returned_at),
    contractReturnOverdueHours: status === "returned_late" || status === "overdue_pending"
      ? Math.max(0, Math.floor(Number(facts.contract_return_overdue_seconds ?? 0) / 3600)) : 0,
  };
}

// Missing cutoff leaves the feature disabled until deployment explicitly enables it.
export function contractReturnCutoff(raw = process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT): string | null {
  if (!raw) return null;
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(raw)
    || !Number.isFinite(Date.parse(raw))) {
    throw new Error("CONTRACT_RETURN_MONITOR_ENABLED_AT 必须为带时区的 ISO 8601 时间");
  }
  if (Number(raw.slice(11,13)) > 23 || Number(raw.slice(14,16)) > 59 || Number(raw.slice(17,19)) > 59) {
    throw new Error("CONTRACT_RETURN_MONITOR_ENABLED_AT 包含无效时间");
  }
  // Date.parse normalizes impossible calendar days (for example September 31).
  // The rollout cutoff must never silently move to another day.
  if (new Date(`${raw.slice(0,10)}T00:00:00Z`).toISOString().slice(0,10) !== raw.slice(0,10)) {
    throw new Error("CONTRACT_RETURN_MONITOR_ENABLED_AT 包含不存在的日历日期");
  }
  return new Date(raw).toISOString();
}
