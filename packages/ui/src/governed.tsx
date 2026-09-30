import type { ComponentProps, ReactNode } from "react";

/** Layout primitives inherit their visual values only inside the governed scope. */
export function KeyFacts({ className = "", ...props }: ComponentProps<"dl">) {
  return <dl className={`dx-key-facts ${className}`.trim()} {...props} />;
}

export function Disclosure({ summary, children, className = "", ...props }: Omit<ComponentProps<"details">, "children"> & { summary: ReactNode; children: ReactNode }) {
  return <details className={`dx-disclosure ${className}`.trim()} {...props}><summary>{summary}</summary>{children}</details>;
}

export function ImageStrip({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={`dx-image-strip ${className}`.trim()} {...props} />;
}

export function WorkflowRail({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={`dx-workflow-rail ${className}`.trim()} {...props} />;
}

export function ActionBar({ className = "", ...props }: ComponentProps<"div">) {
  return <div className={`dx-action-bar ${className}`.trim()} {...props} />;
}

export function DecisionSummary({ title, children }: { title: string; children: ReactNode }) {
  return <section className="dx-decision-summary" aria-label={title}>
    <svg className="dx-decision-summary__icon" viewBox="0 0 24 28" aria-hidden="true"><path d="M3 1h12l7 7v18H3z" fill="currentColor" /><path d="M15 1v8h7M7 13h10M7 17h10M7 21h7" fill="none" stroke="white" strokeWidth="1.5" /></svg>
    <div><h2>{title}</h2>{children}</div>
  </section>;
}

export type FactsColumn<Row> = Readonly<{ key: string; label: string; render: (row: Row) => ReactNode; mobileHeading?: boolean; mobileRender?: (row: Row) => ReactNode }>;
export function ResponsiveFactsTable<Row>({ caption, columns, rows, rowKey, totals, mobileLayout }: {
  mobileLayout?: "compact";
  caption: string; columns: readonly FactsColumn<Row>[]; rows: readonly Row[]; rowKey: (row: Row) => string | number;
  /** Authoritative totals supplied by the caller, never recomputed from formatted cells. */
  totals?: Readonly<Record<string, ReactNode>>;
}) {
  return <section className={`dx-responsive-facts${mobileLayout === "compact" ? " dx-responsive-facts--compact" : ""}`} aria-label={caption}>
    <div className="dx-facts-table-scroll">
    <table className="dx-facts-table"><caption>{caption}</caption>
      <thead><tr>{columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.key}>{column.render(row)}</td>)}</tr>)}</tbody>
      {totals && rows.length > 0 ? <tfoot><tr>{columns.map((column, index) => index === 0
        ? <th scope="row" key={column.key}>{totals[column.key] ?? "合计"}</th>
        : <td key={column.key}>{totals[column.key] ?? "—"}</td>)}</tr></tfoot> : null}
    </table>
    </div>
    <div className="dx-facts-cards">
      <h2>{caption}</h2>
      {rows.map(row => <article className="dx-facts-card" key={rowKey(row)}>
        <dl>{columns.map(column => <div className={column.mobileHeading ? "dx-facts-card__heading" : undefined} key={column.key}>
          <dt>{column.label}</dt><dd>{(column.mobileRender ?? column.render)(row)}</dd>
        </div>)}</dl>
      </article>)}
      {totals && rows.length > 0 ? <dl className="dx-facts-cards__totals">{columns.filter(column => totals[column.key] !== undefined).map(column =>
        <div key={column.key} className={mobileLayout === "compact" && column.mobileHeading ? "dx-facts-cards__total-label" : undefined}><dt>{column.label}</dt><dd>{totals[column.key]}</dd></div>)}</dl> : null}
    </div>
    {!rows.length ? <p className="dx-facts-empty">暂无明细</p> : null}
  </section>;
}
