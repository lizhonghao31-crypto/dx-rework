import type { ComponentProps, ReactNode } from "react";
import { Button, StatusBadge, type Tone } from "./index.js";
import { ResponsiveFactsTable } from "./governed.js";

/** Opt-in visual scope: legacy surfaces never inherit this component stylesheet. */
export function ProductionWorkspace({ children }: { children: ReactNode }) {
  return <div className="dx-production-ui">{children}</div>;
}
export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return <header className="dx-production-header"><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions}</header>;
}
export function FilterBar(props: ComponentProps<"form">) { return <form {...props} className={`dx-production-filters ${props.className ?? ""}`} />; }
export function KpiCard({ label, value, detail, tone = "info", onClick, selected }: { label: string; value: ReactNode; detail?: ReactNode; tone?: Tone; onClick?: () => void; selected?: boolean }) {
  const copy = <><span>{label}</span><strong>{value}</strong><small>{detail}</small></>;
  return onClick ? <button type="button" aria-pressed={selected} onClick={onClick} className={`dx-production-kpi is-${tone}`}>{copy}</button> : <article className={`dx-production-kpi is-${tone}`}>{copy}</article>;
}
export { ResponsiveFactsTable as BusinessTable, ResponsiveFactsTable as NodeTable };
export function RiskPanel({ children, title = "风险与异常" }: { children: ReactNode; title?: string }) { return <section className="dx-production-panel" aria-label={title}><h2>{title}</h2>{children}</section>; }
export function FlowStageCard({ title, status, tone, expectedAt, actualAt, children }: { title: string; status: string; tone: Tone; expectedAt: ReactNode; actualAt: ReactNode; children?: ReactNode }) {
  return <section className="dx-production-stage"><h2>{title}</h2><StatusBadge tone={tone}>{status}</StatusBadge><dl><div><dt>预计完成时间</dt><dd>{expectedAt}</dd></div><div><dt>实际完成时间</dt><dd>{actualAt}</dd></div></dl>{children}</section>;
}
export function DocumentList({ children }: { children: ReactNode }) { return <section className="dx-production-panel"><h2>相关单据</h2>{children}</section>; }
export function ActivityLog({ children }: { children: ReactNode }) { return <section className="dx-production-panel"><h2>操作记录</h2>{children}</section>; }
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  return <nav className="dx-production-pagination" aria-label="分页"><Button disabled={page <= 1} onClick={() => onPage(page - 1)}>上一页</Button><span>第 {page} 页 · 共 {total} 项</span><Button disabled={page * pageSize >= total} onClick={() => onPage(page + 1)}>下一页</Button></nav>;
}
