import { useRef, useState, type ReactNode } from "react";
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
export function DocumentField({ id, label, value, onValue, readonly, disabled, numeric, multiline, maxLength = 100, type = "text", column, issue, onBlur }: {
  id: string; label: string; value: string; onValue?: (value: string) => void; readonly?: boolean; disabled?: boolean;
  numeric?: boolean; multiline?: boolean; maxLength?: number; type?: string; column?: string; issue?: string | undefined; onBlur?: (() => void) | undefined;
}) {
  const entered = useRef(value);
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
  return <span className="dx-doc-field">{readonly ? <span id={id} className="dx-doc-readonly" tabIndex={-1}>{value || "—"}</span> : multiline ? <textarea {...shared} /> : <input {...shared} type={type} inputMode={numeric ? "decimal" : undefined} data-doc-column={column} />}{!readonly&&type==="date"&&<span className="dx-doc-date-value" aria-hidden="true">{value||"YYYY-MM-DD"}</span>}<span className="dx-doc-print-value">{column ? value : value || "—"}</span>{issue && <small id={`${id}-error`} className="dx-doc-field-error">{issue}</small>}</span>;
}
export function DocumentSection({ id, title, detail, children }: { id: string; title: string; detail?: string; children: ReactNode }) {
  return <section id={id} className="dx-doc-card dx-doc-section"><h2>{title}{detail && <small>{detail}</small>}</h2>{children}</section>;
}
export function DocumentAddRow({ label, disabled, onClick }: { label: string; disabled?: boolean; onClick: () => void }) {
  return <Button className="dx-doc-add-row budget-controls" type="button" disabled={disabled} onClick={onClick}>＋ {label}</Button>;
}
