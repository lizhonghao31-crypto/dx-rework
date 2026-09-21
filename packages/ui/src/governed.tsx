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

export type FactsColumn<Row> = Readonly<{ key: string; label: string; render: (row: Row) => ReactNode }>;
export function ResponsiveFactsTable<Row>({ caption, columns, rows, rowKey }: {
  caption: string; columns: readonly FactsColumn<Row>[]; rows: readonly Row[]; rowKey: (row: Row) => string | number;
}) {
  return <div className="dx-facts-table-scroll" role="region" aria-label={caption} tabIndex={0}>
    <table className="dx-facts-table"><caption>{caption}</caption>
      <thead><tr>{columns.map(column => <th scope="col" key={column.key}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.key}>{column.render(row)}</td>)}</tr>)}</tbody>
    </table>
    {!rows.length ? <p className="dx-facts-empty">暂无明细</p> : null}
  </div>;
}
