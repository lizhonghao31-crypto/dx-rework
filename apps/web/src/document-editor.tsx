import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@dx-rework/ui";
import { NavigationIcon } from "./navigation-icons.js";
import "./document-editor.css";

export type DocumentIssue = { id: string; label: string; message: string };
export function DocumentToolbar({ title, status, children }: { title: string; status: string; children: ReactNode }) {
  return <div className="dx-doc-toolbar"><div><NavigationIcon name="FileText" size="title" /><h1>{title}</h1><span className="dx-doc-status" role="status">{status}</span></div><div className="dx-doc-actions">{children}</div></div>;
}
export function DocumentAnchors({ sections }: { sections: Array<{ id: string; label: string }> }) {
  const [active, setActive] = useState(sections[0]?.id);
  return <nav className="dx-doc-anchors" aria-label="单据章节">{sections.map(section => <button key={section.id} type="button" aria-current={active === section.id ? "location" : undefined} onClick={() => { setActive(section.id); document.getElementById(section.id)?.scrollIntoView({ block: "start", behavior: "smooth" }); }}>{section.label}</button>)}</nav>;
}
export function DocumentErrors({ issues, error }: { issues: DocumentIssue[]; error?: string }) {
  if (!issues.length && !error) return null;
  return <div className="dx-doc-errors" role="alert"><strong>{error || "请核对以下内容"}</strong>{issues.length > 0 && <ul>{issues.map((issue, index) => <li key={`${issue.id}-${index}`}><button type="button" onClick={() => { const target = document.getElementById(issue.id); const details = target?.closest("details"); if (details) details.open = true; target?.scrollIntoView({ block: "center" }); target?.focus(); }}>{issue.label}：{issue.message}</button></li>)}</ul>}</div>;
}
export function DocumentField({ id, label, value, onValue, readonly, disabled, numeric, multiline, maxLength = 100, type = "text", column, issue, onBlur, savedValue, savedRevision }: {
  id: string; label: string; value: string; onValue?: (value: string) => void; readonly?: boolean; disabled?: boolean;
  numeric?: boolean; multiline?: boolean; maxLength?: number; type?: string; column?: string; issue?: string | undefined; onBlur?: (() => void) | undefined;
  savedValue?: string; savedRevision?: number;
}) {
  const entered = useRef(value);
  useEffect(() => { if (savedRevision !== undefined && savedValue !== undefined) entered.current = savedValue; }, [savedRevision, savedValue]);
  const shared = { id, "aria-label": label, "aria-invalid": Boolean(issue), "aria-describedby": issue ? `${id}-error` : undefined, disabled, value, maxLength,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onValue?.(event.target.value),
    onFocus: () => { entered.current = value; }, onBlur,
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      if (event.nativeEvent.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); onValue?.(entered.current); }
      if (event.key !== "Enter" || multiline || type !== "text" || !column) return;
      event.preventDefault();
      const rows = [...(event.currentTarget.closest("table")?.querySelectorAll<HTMLElement>("[data-doc-row]") ?? [])];
      const row = event.currentTarget.closest("[data-doc-row]");
      for (const next of rows.slice(rows.indexOf(row as HTMLElement) + 1)) {
        const cell = [...next.querySelectorAll<HTMLInputElement>("input[data-doc-column]")].find(input => input.dataset.docColumn === column && !input.disabled && !input.closest("[hidden]"));
        if (cell && cell.getClientRects().length > 0) { cell.focus(); break; }
      }
    },
  };
  return <span className="dx-doc-field">{readonly ? <span id={id} className="dx-doc-readonly" tabIndex={-1}>{value || "—"}</span> : multiline ? <textarea {...shared} /> : <input {...shared} type={type} inputMode={numeric ? "decimal" : undefined} data-doc-column={column} />}{!readonly&&type==="date"&&<span className="dx-doc-date-value" aria-hidden="true">{value||"请选择日期"}</span>}<span className="dx-doc-print-value">{column ? value : value || "—"}</span>{issue && <small id={`${id}-error`} className="dx-doc-field-error">{issue}</small>}</span>;
}
export function DocumentSection({ id, title, detail, children }: { id: string; title: string; detail?: string; children: ReactNode }) {
  return <section id={id} className="dx-doc-card dx-doc-section"><h2>{title}{detail && <small>{detail}</small>}</h2>{children}</section>;
}
export function DocumentTableScroll({ children, className = "" }: { children: ReactNode; className?: string }) {
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const wrapper = viewport.current;
    const table = wrapper?.querySelector<HTMLTableElement>(":scope > table");
    const head = table?.tHead;
    const toolbar = wrapper?.closest(".dx-doc-budget,.dx-doc-development,.dx-doc-instruction")?.querySelector<HTMLElement>(".dx-doc-toolbar");
    if (!wrapper || !table || !head || !toolbar) return;
    let frame = 0, offset = 0, disposed = false;
    const printMedia = window.matchMedia("print");
    let printing = printMedia.matches;
    const reset = () => { offset = 0; head.style.removeProperty("--dx-doc-header-offset"); };
    const update = () => {
      frame = 0;
      if (disposed || printing || !head.getClientRects().length) return;
      const header = head.getBoundingClientRect();
      const originalTop = header.top - offset;
      const bottom = table.getBoundingClientRect().bottom;
      offset = Math.min(Math.max(0, toolbar.getBoundingClientRect().bottom - originalTop), Math.max(0, bottom - originalTop - header.height));
      head.style.setProperty("--dx-doc-header-offset", `${offset}px`);
    };
    const schedule = () => { if (!disposed && !printing && !frame) frame = window.requestAnimationFrame(update); };
    const beforePrint = () => { printing = true; if (frame) window.cancelAnimationFrame(frame); frame = 0; reset(); };
    const afterPrint = () => { printing = false; schedule(); };
    const printChanged = () => { if (printMedia.matches) beforePrint(); else afterPrint(); };
    const observer = new ResizeObserver(schedule);
    for (const element of [wrapper, table, head, toolbar]) observer.observe(element);
    document.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    printMedia.addEventListener("change", printChanged);
    schedule();
    return () => {
      disposed = true;
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      document.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      printMedia.removeEventListener("change", printChanged);
      reset();
    };
  }, []);
  return <div ref={viewport} className={`dx-doc-table-scroll dx-doc-table-viewport ${className}`.trim()}>{children}</div>;
}
export function DocumentAddRow({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <Button className="dx-doc-add-row budget-controls" type="button" disabled={disabled} onClick={onClick}>＋ {label}</Button>;
}
