import { createElement, type ComponentProps, type ReactNode } from "react";
import { Button, StatusBadge, type Tone } from "./index.js";
import { PageJump } from "./page-jump.js";
import { ResponsiveFactsTable } from "./governed.js";

/** Opt-in visual scope: legacy surfaces never inherit this component stylesheet. */
export function ProductionWorkspace({ children }: { children: ReactNode }) {
  return <div className="dx-production-ui">{children}</div>;
}
export function PageHeader({ title, description, actions, className = "" }: { title: string; description?: ReactNode; actions?: ReactNode; className?: string }) {
  return <header className={`dx-production-header ${className}`}><div><h1>{title}</h1>{description && <p>{description}</p>}</div>{actions}</header>;
}
export function FilterBar({ as = "form", className = "", ...props }: ComponentProps<"form"> & { as?: "form" | "div" }) {
  return createElement(as, { ...props, className: `dx-production-filters ${className}` });
}
export function KpiCard({ label, value, detail, icon,tone = "info", onClick, selected, className = "" }: { label: ReactNode; value: ReactNode; detail?: ReactNode;icon?:ReactNode;tone?: Tone; onClick?: () => void; selected?: boolean; className?: string }) {
  const copy = <>{icon&&<i className="dx-production-kpi-icon" aria-hidden="true">{icon}</i>}<span>{label}</span><strong>{value}</strong><small>{detail}</small></>;
  return onClick ? <button type="button" aria-pressed={selected} onClick={onClick} className={`dx-production-kpi is-${tone} ${className}`}>{copy}</button> : <article className={`dx-production-kpi is-${tone} ${className}`}>{copy}</article>;
}
/** Existing JSX tables can adopt the public frame without moving columns or controls. */
export function BusinessTable<Row>(props: ComponentProps<"table"> | Parameters<typeof ResponsiveFactsTable<Row>>[0]) {
  if ("columns" in props) return <ResponsiveFactsTable {...props} />;
  const { className = "", ...table } = props;
  return <table {...table} className={`dx-production-table ${className}`} />;
}
export const NodeTable = BusinessTable;
export { StatusBadge };
export function RiskPanel({ children, title = "风险与异常" }: { children: ReactNode; title?: string }) { return <section className="dx-production-panel" aria-label={title}><h2>{title}</h2>{children}</section>; }
export function FlowStageCard({ title, status, tone, expectedAt, actualAt, children }: { title: string; status: string; tone: Tone; expectedAt: ReactNode; actualAt: ReactNode; children?: ReactNode }) {
  return <section className="dx-production-stage"><h2>{title}</h2><StatusBadge tone={tone}>{status}</StatusBadge><dl><div><dt>预计完成时间</dt><dd>{expectedAt}</dd></div><div><dt>实际完成时间</dt><dd>{actualAt}</dd></div></dl>{children}</section>;
}
export function DocumentList({ children }: { children: ReactNode }) { return <section className="dx-production-panel"><h2>相关单据</h2>{children}</section>; }
export function ActivityLog({ children }: { children: ReactNode }) { return <section className="dx-production-panel"><h2>操作记录</h2>{children}</section>; }
export { PageJump } from "./page-jump.js";

export function Pagination({ page, pageSize, total, onPage, className = "", busy = false }: {
  page: number; pageSize: number; total: number | null; onPage(page: number): void; className?: string; busy?: boolean;
}) {
  const totalPages = total === null ? null : Math.ceil(total / pageSize);
  const disabled = busy || totalPages === null || totalPages === 0;
  const previousPage = totalPages === null ? page - 1 : Math.min(page - 1, totalPages);
  return (
    <nav className={`dx-production-pagination dx-pagination-frame dx-pagination-frame--native ${className}`} aria-label="分页">
      <span>{total === null ? "读取中" : `共 ${total} 条`} · 第 {page} 页</span>
      <Button type="button" disabled={disabled || page <= 1} onClick={() => onPage(previousPage)}>上一页</Button>
      <Button type="button" disabled={disabled || totalPages === null || page >= totalPages} onClick={() => onPage(page + 1)}>下一页</Button>
      <PageJump page={page} totalPages={totalPages} onPage={onPage} busy={busy} />
    </nav>
  );
}
