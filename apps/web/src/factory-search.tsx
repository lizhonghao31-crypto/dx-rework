import { useMemo, useState } from "react";
import "./factory-search.css";

export type FactoryOption = Readonly<{
  supplierId: string;
  supplierVersion: number;
  supplierName: string;
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
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    const rows: Array<{ value: string; label: string }> = [];
    if (!needle || "本厂".includes(needle)) rows.push({ value: "own_factory", label: "本厂" });
    for (const factory of factories) {
      if (!needle || factory.supplierName.toLocaleLowerCase("zh-CN").includes(needle)) {
        rows.push({ value: `supplier:${factory.supplierId}`, label: factory.supplierName });
      }
      if (rows.length >= 10) break;
    }
    return rows;
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
        placeholder="输入加工厂名称搜索"
        aria-label="加工厂"
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
        <div className="factory-search__results" role="listbox" aria-label="加工厂搜索结果">
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
          )) : <span>没有匹配的加工厂</span>}
        </div>
      ) : null}
    </div>
  );
}
