import { useMemo, useState } from "react";

import { rankUsageSearchOptions } from "./search-option-ranking.js";
import "./search-select.css";

export type HistorySearchOption = Readonly<{
  value: string;
  personalUsageCount?: number | undefined;
  globalUsageCount?: number | undefined;
  lastUsedAt?: string | null | undefined;
}>;

export function HistorySearchInput({
  options,
  value,
  placeholder,
  ariaLabel,
  disabled,
  onChange,
}: {
  options: readonly HistorySearchOption[];
  value: string;
  placeholder: string;
  ariaLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => rankUsageSearchOptions(
    options.map((option) => ({ ...option, label: option.value })),
    value,
  ).slice(0, 12), [options, value]);

  return (
    <div className="search-select">
      <input
        type="search"
        value={value}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      />
      {open && !disabled ? (
        <div className="search-select__results" role="listbox" aria-label={`${ariaLabel}搜索结果`}>
          {matches.length ? matches.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.value}
            </button>
          )) : <span>没有历史记录，可直接输入新颜色</span>}
        </div>
      ) : null}
    </div>
  );
}
