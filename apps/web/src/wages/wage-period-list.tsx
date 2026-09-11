import { NavigationIcon } from "../navigation-icons.js";
import type { ReportPreviewResponse } from "@dx-rework/contracts/reporting";
import { formatBusinessCurrency, formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "../use-debounced-value.js";
import { businessFieldLabel, businessValue } from "../business-display.js";
import { ListPagination, usePaginatedItems } from "../list-pagination.js";
import {
  previewWageSettlement, markWageSettlement,
  loadReport,
  reportExportUrl,
  reportingBusinessDate,
  reportingBusinessMonthStart,
} from "../reporting/reporting-client.js";
import { confirmInApp } from "../system-dialog.js";
import "./wage-period-list.css";

type ReportState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReportPreviewResponse; key: string }
  | { kind: "error"; message: string };

const pad = (value: number): string => String(value).padStart(2, "0");
const monthEnd = (year: number, month: number): string =>
  `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

export function WagePeriodList() {
  const today = reportingBusinessDate();
  const [from, setFrom] = useState(reportingBusinessMonthStart());
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [personType, setPersonType] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [message, setMessage] = useState("");
  const debouncedQ = useDebouncedValue(q, 200);
  const [report, setReport] = useState<ReportState>({ kind: "loading" });
  const filters = useMemo(() => ({
    from,
    to,
    q: debouncedQ.trim() || undefined,
    personType: personType || undefined,
    limit: "500",
  }), [from, to, debouncedQ, personType]);
  const queryKey = JSON.stringify([filters,refresh]);
  const currentKey = useRef(queryKey);
  currentKey.current = queryKey;

  useEffect(() => {
    const controller = new AbortController();
    setReport((current) => current.kind === "ready" ? current : { kind: "loading" });
    void loadReport("wages", filters, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setReport({ kind: "ready", value, key: queryKey }); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setReport({ kind: "error", message: error instanceof Error ? error.message : "工资查询失败" });
        }
      });
    return () => {
      controller.abort();
    };
  }, [filters,queryKey]);

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
  const personSummary = value?.wageSummary?.people ?? [];
  const stale = report.kind !== "ready" || report.key !== queryKey || q.trim() !== debouncedQ.trim();
  const resetKey = `${from}:${to}:${debouncedQ}:${personType}`;
  const settle = async () => {
    if (stale || busyRef.current || !value?.canSettleWages || !value.wageSummary?.pendingLineCount) return;
    busyRef.current = true; setBusy(true); setMessage("");
    const keyAtStart = queryKey;
    try {
      const preview = await previewWageSettlement(filters);
      if (currentKey.current !== keyAtStart) return;
      if (!preview.lineCount) { setRefresh(n=>n+1); return; }
      if (!await confirmInApp(`将当前筛选范围内的 ${formatBusinessDecimal(preview.personCount)} 名工人、${formatBusinessDecimal(preview.lineCount)} 条未结算明细标记为已结算？`)) return;
      if (currentKey.current !== keyAtStart) return;
      const result = await markWageSettlement(filters,preview.lineIds);
      setMessage(`已标记 ${formatBusinessDecimal(result.markedCount)} 条工资明细。`);
      setRefresh(n=>n+1);
    } catch(error) {setMessage(error instanceof Error ? error.message : "工资结算标记失败");setRefresh(n=>n+1);}
    finally {busyRef.current=false;setBusy(false);}
  };
  const personPage = usePaginatedItems(personSummary, resetKey);
  const detailPage = usePaginatedItems(value?.rows ?? [], resetKey);

  return (
    <div className="wage-page wage-management">
      <header className="page-heading">
        <div>
          <h1><NavigationIcon route="/ui/wages" size="title" />工资管理</h1>
          <p>按工人、返工单、款号和期间交叉查询。</p>
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
          <label>工人类型<select value={personType} onChange={event=>setPersonType(event.target.value)}><option value="">全部</option><option value="internal">正式工</option><option value="temporary">临时工</option></select></label>
          <label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <div className="wage-query-actions">
            {value?.canSettleWages ? <Button disabled={stale || busy || !value.wageSummary?.pendingLineCount} onClick={()=>void settle()}>工资已结清</Button> : null}
            {value?.canExport ? <a href={reportExportUrl("wages", filters)} onClick={event=>{if(stale)event.preventDefault();}} aria-disabled={stale}><Button variant="primary" disabled={stale}>导出当前工资明细</Button></a> : null}
          </div>
        </div>
      </Surface>

      {message ? <p role="status" className="form-message">{message}</p> : null}
      {report.kind === "loading" ? <Surface>正在查询工资明细…</Surface> : null}
      {report.kind === "error" ? <Surface><p role="alert" className="form-message">{report.message}</p></Surface> : null}

      {value ? (
        <>
          <section className="wage-summary" aria-label="工资查询汇总">
            <Surface><small>当前明细</small><strong>{formatBusinessDecimal(value.wageSummary?.rowCount ?? value.rowCount)} 条</strong></Surface>
            {Object.entries(value.totals).map(([key, total]) => (
              <Surface key={key}><small>{businessFieldLabel(key)}</small><strong>{businessValue(key, total)}</strong></Surface>
            ))}
          </section>

          <Surface className="wage-person-summary">
            <div className="wage-section-heading">
              <div><h2>按工人汇总</h2><p>随上方姓名、订单与期间条件同步变化。</p></div>
              {value.truncated ? <StatusBadge tone="warning">仅预览前 500 条；汇总、导出及结算使用全部筛选结果</StatusBadge> : null}
            </div>
            {personSummary.length ? (
              <div className="wage-person-grid">
                {personPage.items.map((person) => (
                  <article key={person.personId}>
                    <b>{person.name}</b>
                    <span>{formatBusinessDecimal(person.orderCount)} 张返工单</span>
                    <strong>{formatBusinessCurrency(Number(person.amount))}</strong>
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
                  <tr key={index}>{value.columns.map((column) => <td key={column.key}>{column.key === "settlementStatus" ? <StatusBadge tone={row[column.key] === "settled" ? "success" : "warning"}>{row[column.key] === "settled" ? "已结算" : "未结算"}</StatusBadge> : businessValue(column.key, row[column.key])}</td>)}</tr>
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
