import { useMemo, useState } from "react";
import "./search-select.css";

export type SearchSelectOption = Readonly<{
  value: string;
  label: string;
  keywords?: string;
}>;

export function SearchSelect({
  options,
  value,
  placeholder,
  emptyText = "没有匹配项",
  disabled,
  onChange,
}: {
  options: readonly SearchSelectOption[];
  value: string;
  placeholder: string;
  emptyText?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  const selectedLabel = options.find((option) => option.value === value)?.label ?? "";
  const [query, setQuery] = useState(selectedLabel);
  const [open, setOpen] = useState(false);

  const matches = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return options
      .filter((option) => {
        if (!needle) return true;
        const haystack = `${option.label} ${option.keywords ?? ""}`.toLocaleLowerCase("zh-CN");
        return haystack.includes(needle);
      })
      .slice(0, 12);
  }, [options, query]);

  const choose = (option: SearchSelectOption) => {
    onChange(option.value);
    setQuery(option.label);
    setOpen(false);
  };

  return (
    <div className="search-select">
      <input
        type="search"
        value={open ? query : selectedLabel}
        placeholder={placeholder}
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
        <div className="search-select__results" role="listbox">
          {matches.length ? matches.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              key={option.value}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
            >
              {option.label}
            </button>
          )) : <span>{emptyText}</span>}
        </div>
      ) : null}
    </div>
  );
}
