export type SourcingListMode = "pending" | "history";
export type SourcingStageFilter =
  | "all"
  | "ie"
  | "management"
  | "owner"
  | "finance"
  | "factory_change"
  | "exception";
export type SourcingGenderFilter = "all" | "男装" | "女装" | "missing";
export type SourcingContractReturnFilter = "all" | "pending" | "returned_on_time"
  | "overdue_pending" | "returned_late" | "all_overdue";

export type SourcingListQuery = Readonly<{
  q: string;
  stage: SourcingStageFilter;
  gender: SourcingGenderFilter;
  styleName: string;
  contractReturn: SourcingContractReturnFilter | null;
  page: number;
}>;

const stages = new Set<SourcingStageFilter>([
  "all", "ie", "management", "owner", "finance", "factory_change", "exception",
]);
const genders = new Set<SourcingGenderFilter>(["all", "男装", "女装", "missing"]);
const contractReturns = new Set<SourcingContractReturnFilter>([
  "all","pending","returned_on_time","overdue_pending","returned_late","all_overdue",
]);

export function readSourcingListQuery(search: string): SourcingListQuery {
  const params = new URLSearchParams(search);
  const page = Number(params.get("page") ?? "1");
  const stage = params.get("stage") as SourcingStageFilter | null;
  const gender = params.get("gender") as SourcingGenderFilter | null;
  const contractReturn = params.get("contractReturn") as SourcingContractReturnFilter | null;
  return {
    q: (params.get("q") ?? "").slice(0, 100),
    stage: stage && stages.has(stage) ? stage : "all",
    gender: gender && genders.has(gender) ? gender : "all",
    styleName: (params.get("styleName") ?? "").slice(0, 100),
    contractReturn: contractReturn && contractReturns.has(contractReturn) ? contractReturn : null,
    page: Number.isSafeInteger(page) && page > 0 && page <= 100_000 ? page : 1,
  };
}

export function sourcingListPath(mode: SourcingListMode, value: SourcingListQuery): string {
  const params = new URLSearchParams();
  if (value.q.trim()) params.set("q", value.q.trim());
  if (mode === "pending" && value.stage !== "all") params.set("stage", value.stage);
  if (value.gender !== "all") params.set("gender", value.gender);
  if (value.styleName.trim()) params.set("styleName", value.styleName.trim());
  if (value.contractReturn !== null) params.set("contractReturn", value.contractReturn);
  if (value.page > 1) params.set("page", String(value.page));
  return `/ui/sourcing/${mode}${params.size ? `?${params}` : ""}`;
}

export function sourcingReturnPath(search: string): string | null {
  const target = new URLSearchParams(search).get("returnTo");
  if (!target || target.includes("\\")) return null;
  const [pathname, rawQuery = ""] = target.split("?", 2);
  const mode = pathname === "/ui/sourcing/pending"
    ? "pending"
    : pathname === "/ui/sourcing/history" ? "history" : null;
  return mode ? sourcingListPath(mode, readSourcingListQuery(rawQuery)) : null;
}

export function withSourcingReturn(
  target: string,
  mode: SourcingListMode,
  value: SourcingListQuery,
): string {
  const separator = target.includes("?") ? "&" : "?";
  return `${target}${separator}returnTo=${encodeURIComponent(sourcingListPath(mode, value))}`;
}
