import { useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";
export type ButtonVariant = "primary" | "secondary";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant };

export function Button({ className = "", variant = "secondary", ...props }: ButtonProps) {
  return <button className={`dx-button dx-button--${variant} ${className}`.trim()} {...props} />;
}

export function StatusBadge({ tone = "neutral", children }: { tone?: Tone; children: ReactNode }) {
  return <span className={`dx-badge dx-badge--${tone}`}>{children}</span>;
}

export function NavigationItem({ active = false, icon, children }: { active?: boolean; icon: ReactNode; children: ReactNode }) {
  return <span className={`dx-nav-item${active ? " is-active" : ""}`}><b aria-hidden="true">{icon}</b>{children}</span>;
}

export function KpiInstrument({ label, value, detail, tone = "info" }: { label: string; value: string | number; detail: string; tone?: Tone }) {
  return <article className="dx-kpi"><span>{label}</span><strong>{value}</strong><small>{detail}</small><i aria-hidden="true" className={`dx-meter dx-meter--${tone}`} /></article>;
}

export function InsetField({ label, suffix, error, optional = false, id, required, "aria-describedby": describedBy, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; suffix?: string; error?: string; optional?: boolean }) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const errorId = `${inputId}-error`;
  return <label className="dx-field" htmlFor={inputId}><span>{label}{required && !/[*＊]|必填/.test(label) && <span aria-hidden="true" className="dx-field__required"> *</span>}{optional && !required && !label.includes("选填") && "（选填）"}</span><span className="dx-field__control"><input {...props} id={inputId} required={required} aria-invalid={error ? true : props["aria-invalid"]} aria-describedby={[describedBy, error ? errorId : undefined].filter(Boolean).join(" ") || undefined} />{suffix && <em>{suffix}</em>}</span>{error && <small id={errorId} className="dx-field__error" role="alert">{error}</small>}</label>;
}

export function Surface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`dx-surface ${className}`.trim()}>{children}</section>;
}

export { DecisionSummary, KeyFacts, Disclosure, ImageStrip, WorkflowRail, ResponsiveFactsTable, ActionBar } from "./governed.js";
export type { FactsColumn } from "./governed.js";
