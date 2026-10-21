import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type SelectHTMLAttributes } from "react";
import { createPortal } from "react-dom";
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
  ariaLabel,
  disabled,
  onChange,
  onSearchChange,
}: {
  options: readonly SearchSelectOption[];
  value: string;
  placeholder: string;
  emptyText?: string;
  ariaLabel?: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSearchChange?: (query: string) => void;
}) {
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const [active, setActive] = useState(-1);
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
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && active >= 0 && matches[active] ? `${listId}-${active}` : undefined}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={() => { composing.current = false; }}
        onKeyDown={event => {
          if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } return; }
          if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); setOpen(false); } return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault(); setOpen(true);
            setActive(index => !matches.length ? -1 : index < 0 ? (event.key === "ArrowDown" ? 0 : matches.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
          } else if (event.key === "Enter" && open) {
            event.preventDefault();
            const option = matches[active]; if (option) choose(option);
          }
        }}
        value={open ? query : selectedLabel}
        placeholder={placeholder}
        aria-label={ariaLabel}
        autoComplete="off"
        disabled={disabled}
        onFocus={() => {
          setQuery(selectedLabel);
          setOpen(true);
        }}
        onChange={(event) => {
          setActive(-1);
          setQuery(event.target.value);
          onSearchChange?.(event.target.value);
          onChange("");
          setOpen(true);
        }}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
      />
      <button className="search-select__toggle" type="button" disabled={disabled} tabIndex={-1}
        aria-label={open ? "收起已有选项" : "展开已有选项"} aria-expanded={open}
        onMouseDown={event => event.preventDefault()}
        onClick={() => { input.current?.focus(); setOpen(!open); setQuery(""); setActive(-1); }}></button>
      {open && !disabled ? (
        <div id={listId} className="search-select__results" role="listbox" aria-label={ariaLabel ? `${ariaLabel}搜索结果` : undefined}>
          {matches.length ? matches.map((option, index) => (
            <button
              type="button"
              role="option"
              id={`${listId}-${index}`}
              data-active={index === active || undefined}
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

/** Search is transient; only an existing enabled native option can change the value.
 * The native control remains responsible for FormData, required, and change events.
 */
export function SearchableSelect({ children, onSearchChange, menuPortal = false, ...props }: SelectHTMLAttributes<HTMLSelectElement> & { onSearchChange?: (query: string) => void; menuPortal?: boolean }) {
  const composing = useRef(false);
  const native = useRef<HTMLSelectElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const wrapper = useRef<HTMLDivElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [error, setError] = useState("");
  const [placement, setPlacement] = useState<CSSProperties | null>(null);
  const [snapshot, setSnapshot] = useState<{ value: string; rows: Array<{ value: string; label: string; disabled: boolean }> }>({ value: "", rows: [] });
  useLayoutEffect(() => {
    const select = native.current;
    if (!select) return;
    const next = { value: select.value, rows: Array.from(select.options, option => ({ value: option.value, label: option.label, disabled: option.disabled || Boolean(option.closest("optgroup")?.disabled) })) };
    setSnapshot(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  });
  const matches = snapshot.rows.filter(row => row.label.toLocaleLowerCase("zh-CN").includes(query.trim().toLocaleLowerCase("zh-CN")));
  const selected = snapshot.rows.find(row => row.value === snapshot.value)?.label ?? "";
  const close = useCallback(() => { setOpen(false); setQuery(""); setActive(-1); onSearchChange?.(""); }, [onSearchChange]);
  useLayoutEffect(() => {
    if (!menuPortal || !open) return;
    const anchor = wrapper.current, panel = popup.current, select = native.current;
    if (!anchor || !panel || !select) return;
    const position = () => {
      if (select.matches(":disabled")) { close(); return; }
      const rect = anchor.getBoundingClientRect(), viewport = window.visualViewport;
      const top = viewport?.offsetTop ?? 0, left = viewport?.offsetLeft ?? 0;
      const width = viewport?.width ?? window.innerWidth, height = viewport?.height ?? window.innerHeight;
      if (!rect.width || !rect.height || rect.bottom <= top || rect.top >= top + height || rect.right <= left || rect.left >= left + width) { close(); return; }
      for (let parent = anchor.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if ((/(auto|scroll|hidden|clip)/.test(style.overflowY) && (rect.bottom <= bounds.top || rect.top >= bounds.bottom)) ||
          (/(auto|scroll|hidden|clip)/.test(style.overflowX) && (rect.right <= bounds.left || rect.left >= bounds.right))) { close(); return; }
      }
      const below = Math.max(0, top + height - rect.bottom - 14), above = Math.max(0, rect.top - top - 14);
      const downward = below >= Math.min(180, panel.scrollHeight) || below >= above;
      const maximum = Math.min(300, downward ? below : above);
      const panelHeight = Math.min(panel.scrollHeight + 2, maximum);
      const panelWidth = Math.min(rect.width, Math.max(0, width - 16));
      const next: CSSProperties = { position: "fixed", right: "auto", width: panelWidth,
        left: Math.max(left + 8, Math.min(rect.left, left + width - panelWidth - 8)),
        top: downward ? rect.bottom + 6 : rect.top - 6 - panelHeight, maxHeight: maximum, visibility: "visible" };
      setPlacement(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchor.contains(event.target) && !panel.contains(event.target)) close();
    };
    position();
    window.addEventListener("scroll", position, true);
    window.addEventListener("resize", position);
    window.addEventListener("pointerdown", outside, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    const resize = new ResizeObserver(position); resize.observe(anchor); resize.observe(panel);
    const disabled = new MutationObserver(position);
    disabled.observe(select, { attributes: true, attributeFilter: ["disabled"] });
    const fieldset = select.closest("fieldset");
    if (fieldset) disabled.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
    return () => {
      window.removeEventListener("scroll", position, true); window.removeEventListener("resize", position);
      window.removeEventListener("pointerdown", outside, true);
      window.visualViewport?.removeEventListener("resize", position); window.visualViewport?.removeEventListener("scroll", position);
      resize.disconnect(); disabled.disconnect();
    };
  }, [open, menuPortal, matches.length, close]);
  const choose = (value: string) => {
    const select = native.current;
    if (!select || select.matches(":disabled")) return;
    const option = Array.from(select.options).find(option => option.value === value);
    if (!option || option.disabled || option.closest("optgroup")?.disabled) return;
    select.value = value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
    setError("");
    close();
    input.current?.focus();
  };
  const results = open && !props.disabled ? <div ref={popup} className={`search-select__results${menuPortal ? " search-select__results--viewport" : ""}`} role="listbox" id={listId}
    style={menuPortal ? placement ?? { position: "fixed", visibility: "hidden" } : undefined}>
    {matches.length ? matches.map((row, index) => <button type="button" role="option" id={`${listId}-${index}`} tabIndex={-1} key={`${index}:${row.value}`} disabled={row.disabled} aria-selected={row.value === snapshot.value} data-active={index === active || undefined} onMouseDown={event => event.preventDefault()} onClick={() => choose(row.value)}>{row.label}</button>) : <span>没有匹配的已有选项</span>}
  </div> : null;
  return <div ref={wrapper} className="search-select native-search-select" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !popup.current?.contains(event.relatedTarget)) close(); }}>
    <input ref={input} id={props.id} type="text" role="combobox" autoComplete="off" disabled={props.disabled}
      aria-label={props["aria-label"]} aria-labelledby={props["aria-labelledby"]}
      aria-describedby={error ? `${listId}-error` : props["aria-describedby"]} aria-invalid={error ? true : props["aria-invalid"]}
      aria-required={props.required} aria-expanded={open} aria-controls={listId} aria-autocomplete="list"
      aria-activedescendant={open && active >= 0 && matches[active] ? `${listId}-${active}` : undefined}
      value={open ? query : selected} placeholder={selected || "输入关键词选择"}
      onClick={() => { if (!open) { setOpen(true); setQuery(""); setActive(-1); } }}
      onChange={event => { setQuery(event.target.value); setOpen(true); setActive(-1); onSearchChange?.(event.target.value); }}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={event => {
        if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) { if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); } return; }
        if (event.key === "Escape") { if (open) { event.preventDefault(); event.stopPropagation(); close(); } return; }
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault(); setOpen(true);
          const direction = event.key === "ArrowDown" ? 1 : -1;
          let index = active < 0 ? (direction === 1 ? -1 : 0) : active;
          for (let attempt = 0; attempt < matches.length; attempt++) {
            index = (index + direction + matches.length) % matches.length;
            if (!matches[index]?.disabled) { setActive(index); requestAnimationFrame(() => document.getElementById(`${listId}-${index}`)?.scrollIntoView({ block: "nearest" })); break; }
          }
        } else if (event.key === "Enter" && open) {
          event.preventDefault();
          const row = matches[active];
          if (row && !row.disabled) choose(row.value);
        }
      }} />
    <select {...props} ref={native} id={props.id ? `${props.id}-native` : undefined} className="native-search-select__native" tabIndex={-1} aria-hidden="true"
      onFocus={() => input.current?.focus()}
      onInvalid={event => { props.onInvalid?.(event); event.preventDefault(); setError("请选择已有选项"); input.current?.focus(); }}
      onChange={event => { const value = event.currentTarget.value; setSnapshot(previous => ({ ...previous, value })); props.onChange?.(event); }}>
      {children}
    </select>
    <button className="native-search-select__toggle" type="button" disabled={props.disabled} tabIndex={-1} aria-label={open ? "收起已有选项" : "展开已有选项"} aria-expanded={open} onClick={() => { setOpen(!open); setQuery(""); setActive(-1); input.current?.focus(); }}></button>
    {menuPortal && results ? createPortal(results, document.body) : results}
    {error && <span id={`${listId}-error`} role="alert">{error}</span>}
  </div>;
}
