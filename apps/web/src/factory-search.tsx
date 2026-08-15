import { useMemo, useState } from "react";
import "./factory-search.css";
import { rankUsageSearchOptions } from "./search-option-ranking.js";

export type FactoryOption = Readonly<{
  supplierId: string;
  supplierVersion: number;
  supplierName: string;
  personalUsageCount?: number | undefined;
  globalUsageCount?: number | undefined;
  lastUsedAt?: string | null | undefined;
}>;

export function FactorySearch({
  factories,
  value,
  disabled,
  onChange,
}: {
  factories: readonly FactoryOption[];
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selectedLabel = value === "own_factory"
    ? "本厂"
    : value.startsWith("supplier:")
      ? factories.find((factory) => `supplier:${factory.supplierId}` === value)?.supplierName ?? ""
      : "";
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const rows = [
      { value: "own_factory", label: "本厂" },
      ...factories.map((factory) => ({
        value: `supplier:${factory.supplierId}`,
        label: factory.supplierName,
        personalUsageCount: factory.personalUsageCount,
        globalUsageCount: factory.globalUsageCount,
        lastUsedAt: factory.lastUsedAt,
      })),
    ];
    return rankUsageSearchOptions(rows, query).slice(0, 10);
  }, [factories, query]);

  const choose = (nextValue: string, label: string) => {
    onChange(nextValue);
    setQuery(label);
    setOpen(false);
  };

  return (
    <div className="factory-search">
      <input
        type="search"
        value={open ? query : selectedLabel}
        placeholder="输入供应商名称搜索"
        aria-label="供应商"
        autoComplete="off"
        disabled={disabled}
        onFocus={() => {
          setQuery(selectedLabel);
          setOpen(true);
        }}
        onChange={(event) => {
          setQuery(event.target.value);
          onChange("");
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      />
      {open && !disabled ? (
        <div className="factory-search__results" role="listbox" aria-label="供应商搜索结果">
          {matches.length ? matches.map((match) => (
            <button
              type="button"
              role="option"
              key={match.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(match.value, match.label)}
            >
              {match.label}
            </button>
          )) : <span>没有匹配的供应商</span>}
        </div>
      ) : null}
    </div>
  );
}
