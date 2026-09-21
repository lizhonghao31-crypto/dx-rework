import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

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

export function InsetField({ label, suffix, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; suffix?: string }) {
  return <label className="dx-field"><span>{label}</span><span className="dx-field__control"><input {...props} />{suffix && <em>{suffix}</em>}</span></label>;
}

export function Surface({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`dx-surface ${className}`.trim()}>{children}</section>;
}

export { KeyFacts, Disclosure, ImageStrip, WorkflowRail, ResponsiveFactsTable, ActionBar } from "./governed.js";
export type { FactsColumn } from "./governed.js";
