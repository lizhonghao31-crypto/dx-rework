export type UsageSearchOption = Readonly<{
  label: string;
  personalUsageCount?: number | undefined;
  globalUsageCount?: number | undefined;
  lastUsedAt?: string | null | undefined;
}>;

const normalized = (value: string): string => value.trim().toLocaleLowerCase("zh-CN");

const matchRank = (label: string, query: string): number => {
  const haystack = normalized(label);
  const needle = normalized(query);
  if (!needle) return 0;
  if (haystack === needle) return 0;
  if (haystack.startsWith(needle)) return 1;
  if (haystack.includes(needle)) return 2;
  return 3;
};

const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export const rankUsageSearchOptions = <T extends UsageSearchOption>(
  options: readonly T[],
  query: string,
): T[] => options
  .map((option) => ({ option, match: matchRank(option.label, query) }))
  .filter(({ match }) => match < 3)
  .sort((left, right) => (
    left.match - right.match
    || (right.option.personalUsageCount ?? 0) - (left.option.personalUsageCount ?? 0)
    || (right.option.globalUsageCount ?? 0) - (left.option.globalUsageCount ?? 0)
    || (right.option.lastUsedAt ?? "").localeCompare(left.option.lastUsedAt ?? "")
    || collator.compare(left.option.label, right.option.label)
  ))
  .map(({ option }) => option);
