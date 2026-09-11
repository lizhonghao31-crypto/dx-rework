import { NavigationIcon } from "../navigation-icons.js";
import type { ReportPreviewResponse } from "@dx-rework/contracts/reporting";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useState } from "react";
import { createWebUrls } from "../../url-contract.js";
import { verifySession } from "../auth.js";
import { createClientRequestId } from "../client-request-id.js";
import { confirmInApp, alertInApp } from "../system-dialog.js";
import { useDebouncedValue } from "../use-debounced-value.js";
import { businessFieldLabel, businessValue } from "../business-display.js";
import { ListPagination, usePaginatedItems } from "../list-pagination.js";
import {
  loadReport,
  reportExportUrl,
  reportingBusinessDate,
  reportingBusinessMonthStart,
} from "../reporting/reporting-client.js";
import "./wage-period-list.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type ReportState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReportPreviewResponse }
  | { kind: "error"; message: string };

type SettlementSummary = Readonly<{ personCount: number; itemCount: number }>;

const pad = (value: number): string => String(value).padStart(2, "0");
const monthEnd = (year: number, month: number): string =>
  `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

export function WagePeriodList() {
  const today = reportingBusinessDate();
  const [from, setFrom] = useState(reportingBusinessMonthStart());
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [personType, setPersonType] = useState<"" | "internal" | "temporary">("");
  const debouncedQ = useDebouncedValue(q, 200);
  const [report, setReport] = useState<ReportState>({ kind: "loading" });
  const [canSettle, setCanSettle] = useState(false);
  const [settling, setSettling] = useState(false);
  const filters = useMemo(() => ({
    from,
    to,
    q: debouncedQ.trim() || undefined,
    personType: personType || undefined,
    limit: "500",
  }), [from, to, debouncedQ, personType]);

  const reloadReport = () => {
    const controller = new AbortController();
    setReport({ kind: "loading" });
    void loadReport("wages", filters, controller.signal)
      .then((value) => setReport({ kind: "ready", value }))
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setReport({ kind: "error", message: error instanceof Error ? error.message : "工资查询失败" });
        }
      });
    return controller;
  };

  useEffect(() => {
    const controller = reloadReport();
    return () => controller.abort();
  }, [filters]);

  useEffect(() => {
    let mounted = true;
    void verifySession().then((session) => {
      if (!mounted || session === "denied" || session.status !== "authorized") return;
      setCanSettle(session.user.isRoot === true || session.user.capabilities.includes("wage:settlement_mark"));
    });
    return () => { mounted = false; };
  }, []);

  const setMonth = () => {
    setFrom(reportingBusinessMonthStart());
    setTo(today);
  };
  const setQuarter = () => {
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    const startMonth = Math.floor((month - 1) / 3) * 3 + 1;
    setFrom(`${year}-${pad(startMonth)}-01`);
    setTo(monthEnd(year, startMonth + 2));
  };
  const setYear = () => {
    const year = today.slice(0, 4);
    setFrom(`${year}-01-01`);
    setTo(`${year}-12-31`);
  };

  const value = report.kind === "ready" ? report.value : null;
  const personSummary = useMemo(() => {
    if (!value) return [];
    const rows = new Map<string, { id: string; name: string; orderCount: Set<string>; amount: number }>();
    for (const row of value.rows) {
      const id = String(row.personId ?? row.personName ?? "未知人员");
      const name = String(row.personName ?? "未知人员");
      const current = rows.get(id) ?? { id, name, orderCount: new Set<string>(), amount: 0 };
      current.orderCount.add(String(row.reworkNo ?? row.reworkOrderId ?? "未知返工单"));
      current.amount += Number(row.wageAmount ?? 0);
      rows.set(id, current);
    }
    return [...rows.values()].sort((left, right) => right.amount - left.amount);
  }, [value]);
  const resetKey = `${from}:${to}:${debouncedQ}:${personType}`;
  const personPage = usePaginatedItems(personSummary, resetKey);
  const detailPage = usePaginatedItems(value?.rows ?? [], resetKey);

  const settlementPayload = () => ({
    from,
    to,
    ...(debouncedQ.trim() ? { q: debouncedQ.trim() } : {}),
    ...(personType ? { personType } : {}),
  });

  const markSettled = async () => {
    if (!canSettle || settling || report.kind !== "ready") return;
    setSettling(true);
    try {
      const query = new URLSearchParams();
      const payload = settlementPayload();
      for (const [key, entry] of Object.entries(payload)) query.set(key, entry);
      const summaryResponse = await fetch(`${apiUrl("wage-settlements/summary")}?${query.toString()}`, {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!summaryResponse.ok) throw new Error("工资结算范围读取失败");
      const summary = await summaryResponse.json() as SettlementSummary;
      if (summary.itemCount === 0) {
        await alertInApp("当前筛选范围没有未结算工资明细。", { title: "无需处理" });
        return;
      }
      const confirmed = await confirmInApp(
        `将当前筛选范围内的 ${formatBusinessDecimal(summary.personCount)} 名工人、${formatBusinessDecimal(summary.itemCount)} 条未结算明细标记为已结算？`,
        { title: "确认工资已结清", confirmLabel: "确认结清" },
      );
      if (!confirmed) return;
      const response = await fetch(apiUrl("wage-settlements"), {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "idempotency-key": createClientRequestId(),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        throw new Error(body?.error?.message ?? "工资结算标记失败");
      }
      const result = await response.json() as { value?: SettlementSummary };
      await alertInApp(
        `已标记 ${formatBusinessDecimal(result.value?.personCount ?? summary.personCount)} 名工人、${formatBusinessDecimal(result.value?.itemCount ?? summary.itemCount)} 条工资明细。`,
        { title: "工资已结清" },
      );
      reloadReport();
    } catch (error: unknown) {
      await alertInApp(error instanceof Error ? error.message : "工资结算标记失败", { title: "操作失败" });
    } finally {
      setSettling(false);
    }
  };

  return (
    <div className="wage-page wage-management">
      <header className="page-heading">
        <div>
          <h1><NavigationIcon route="/ui/wages" size="title" />工资管理</h1>
          <p>按工人、返工单、款号、工人类型和完成日期交叉查询。</p>
        </div>
      </header>

      <Surface className="wage-query-card">
        <div className="wage-shortcuts" aria-label="工资周期快捷查询">
          <Button onClick={setMonth}>本月</Button>
          <Button onClick={setQuarter}>本季度</Button>
          <Button onClick={setYear}>本年度</Button>
        </div>
        <div className="wage-query-grid">
          <InsetField
            label="工人 / 返工单 / 款号"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="输入工人姓名、返工单号或款号"
          />
          <label>工人类型<select value={personType} onChange={(event) => setPersonType(event.target.value as "" | "internal" | "temporary")}>
            <option value="">全部</option>
            <option value="internal">正式工</option>
            <option value="temporary">临时工</option>
          </select></label>
          <label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <div className="wage-query-actions">
            {canSettle ? <Button disabled={settling || report.kind !== "ready"} onClick={() => { void markSettled(); }}>{settling ? "处理中…" : "工资已结清"}</Button> : null}
            {value?.canExport ? <a href={reportExportUrl("wages", filters)}><Button variant="primary">导出当前工资明细</Button></a> : null}
          </div>
        </div>
      </Surface>

      {report.kind === "loading" ? <Surface>正在查询工资明细…</Surface> : null}
      {report.kind === "error" ? <Surface><p role="alert" className="form-message">{report.message}</p></Surface> : null}

      {value ? (
        <>
          <section className="wage-summary" aria-label="工资查询汇总">
            <Surface><small>当前明细</small><strong>{formatBusinessDecimal(value.rowCount)} 条</strong></Surface>
            {Object.entries(value.totals).map(([key, total]) => (
              <Surface key={key}><small>{businessFieldLabel(key)}</small><strong>{businessValue(key, total)}</strong></Surface>
            ))}
          </section>

          <Surface className="wage-person-summary">
            <div className="wage-section-heading">
              <div><h2>按工人汇总</h2><p>随上方姓名、订单、工人类型与日期条件同步变化。</p></div>
              {value.truncated ? <StatusBadge tone="warning">明细超过 500 条，明细表仅预览前 500 条</StatusBadge> : null}
            </div>
            {personSummary.length ? (
              <div className="wage-person-grid">
                {personPage.items.map((person) => (
                  <article key={person.id}>
                    <b>{person.name}</b>
                    <span>{formatBusinessDecimal(person.orderCount.size)} 张返工单</span>
                    <strong>{formatBusinessCurrency(person.amount)}</strong>
                  </article>
                ))}
              </div>
            ) : <p>当前条件没有工资数据。</p>}
            <ListPagination page={personPage.page} totalPages={personPage.totalPages} onPageChange={personPage.setPage} ariaLabel="工人工资汇总分页" />
          </Surface>

          <Surface className="wage-detail-table">
            <div className="wage-section-heading"><div><h2>逐单逐人工资明细</h2><p>每一行对应一名工人在一张返工单的一项工资。</p></div></div>
            <div className="reporting-table-wrap">
              <table>
                <thead><tr>{value.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                <tbody>{detailPage.items.map((row, index) => (
                  <tr key={index}>{value.columns.map((column) => <td key={column.key}>{column.key === "settlementStatus"
                    ? <StatusBadge tone={row[column.key] === "已结算" ? "success" : "warning"}>{String(row[column.key] ?? "未结算")}</StatusBadge>
                    : businessValue(column.key, row[column.key])}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
            {value.rows.length === 0 ? <p>当前筛选范围没有工资明细。</p> : null}
            <ListPagination page={detailPage.page} totalPages={detailPage.totalPages} onPageChange={detailPage.setPage} ariaLabel="工资明细分页" />
          </Surface>
        </>
      ) : null}
    </div>
  );
}
