import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResponsiveFactsTable, type FactsColumn } from "../../packages/ui/src/governed.js";

type Line = { style: string; quantity: number; amount: string };
const rows: Line[] = [{ style: "DX-long-style", quantity: 2, amount: "¥0.02" }];
const columns: FactsColumn<Line>[] = [
  { key: "style", label: "款号", mobileHeading: true, render: row => row.style },
  { key: "quantity", label: "数量", render: row => row.quantity },
  { key: "amount", label: "本款金额", render: row => row.amount },
];
const render = (budget: boolean, empty = false) => renderToStaticMarkup(createElement(ResponsiveFactsTable<Line>, {
  caption: "款式明细", rows: empty ? [] : rows, rowKey: row => row.style,
  columns: budget ? [...columns, { key: "budget", label: "预算价", render: () => "¥12.34" }] : columns,
  totals: { style: "合计", quantity: "2 件", amount: "¥0.03" },
}));

describe("governed sourcing responsive facts", () => {
  it("preserves authoritative totals in both layouts instead of summing rounded visible cells", () => {
    const html = render(false);
    const desktop = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    const mobile = html.slice(html.indexOf('class="dx-facts-cards"'));
    expect(desktop).toContain('<th scope="col">数量</th>');
    expect(desktop).toContain('<th scope="row">合计</th>');
    expect(desktop).toContain("¥0.03");
    expect(mobile).toContain("<dt>数量</dt><dd>2</dd>");
    expect(mobile).toContain("¥0.03");
    expect(mobile).toContain("DX-long-style");
  });
  it("does not invent a budget field in either layout when the caller omitted it", () => {
    expect(render(false)).not.toContain("预算价");
    expect(render(true).match(/预算价/g)).toHaveLength(2);
    expect(render(true).match(/¥12.34/g)).toHaveLength(2);
  });
  it("renders a single empty state without a misleading totals row", () => {
    const html = render(false, true);
    expect(html.match(/暂无明细/g)).toHaveLength(1);
    expect(html).not.toContain("合计");
    expect(html).not.toContain("¥0.03");
  });
  it("keeps secondary facts available on mobile without replacing desktop values or totals", () => {
    const html = renderToStaticMarkup(createElement(ResponsiveFactsTable<Line>, {
      caption: "款式明细", mobileLayout: "compact", rows, rowKey: row => row.style,
      columns: [{ ...columns[0]!, mobileRender: row => createElement("details", null,
        createElement("summary", null, row.style), "代用：ALT-001") }, ...columns.slice(1)],
      totals: { style: "合计", quantity: "2 件", amount: "¥0.03" },
    }));
    const desktop = html.slice(html.indexOf("<table"), html.indexOf("</table>"));
    const mobile = html.slice(html.indexOf('class="dx-facts-cards"'));
    expect(desktop).toContain("DX-long-style");
    expect(desktop).not.toContain("<details");
    expect(mobile).toContain("<details><summary>DX-long-style</summary>代用：ALT-001</details>");
    expect(mobile).toContain('class="dx-facts-cards__total-label"');
    expect(mobile).toContain("¥0.03");
    expect(render(false)).not.toContain("dx-responsive-facts--compact");
  });
});
