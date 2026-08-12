import { WagePeriodSchema, type WagePeriod } from "@dx-rework/contracts/wages";
import type { ReportPreviewResponse } from "@dx-rework/contracts/reporting";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";

import { createWebUrls } from "../../url-contract.js";
import { businessFieldLabel, businessValue } from "../business-display.js";
import {
  loadReport,
  reportExportUrl,
  reportingBusinessDate,
  reportingBusinessMonthStart,
} from "../reporting/reporting-client.js";
import "./wage-period-list.css";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
const PeriodListSchema = z.array(WagePeriodSchema);

const statusLabel: Record<WagePeriod["status"], string> = {
  pending_tail_review: "待当前有效尾部主管初核",
  pending_admin_review: "待当前有效行政复核角色复核",
  ready_to_lock: "待当前有效月结角色处理",
  locked: "已锁定",
};

const statusOptions = [
  ["", "全部状态"],
  ["pending_tail_review", "待尾部初核"],
  ["pending_admin_review", "待行政复核"],
  ["ready_to_lock", "待月结"],
  ["locked", "已锁定"],
] as const;

type ReportState =
  | { kind: "loading" }
  | { kind: "ready"; value: ReportPreviewResponse }
  | { kind: "error"; message: string };

const pad = (value: number): string => String(value).padStart(2, "0");
const monthEnd = (year: number, month: number): string =>
  `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

export function WagePeriodList() {
  const today = reportingBusinessDate();
  const [periods, setPeriods] = useState<WagePeriod[]>([]);
  const [message, setMessage] = useState("");
  const [from, setFrom] = useState(reportingBusinessMonthStart());
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [report, setReport] = useState<ReportState>({ kind: "loading" });
  const busy = useRef(false);
  const mounted = useRef(true);

  const loadPeriods = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      const response = await fetch(apiUrl("wage-periods"), {
        credentials: "include",
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error("工资月份加载失败");
      const rows = PeriodListSchema.parse(await response.json());
      if (mounted.current) {
        setPeriods(rows);
        setMessage("");
      }
    } catch (error: unknown) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : "工资月份加载失败");
    } finally {
      busy.current = false;
    }
  }, []);

  const filters = useMemo(() => ({
    from,
    to,
    q: q.trim() || undefined,
    status: status || undefined,
    limit: "500",
  }), [from, to, q, status]);

  useEffect(() => {
    mounted.current = true;
    void loadPeriods();
    return () => {
      mounted.current = false;
    };
  }, [loadPeriods]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      setReport({ kind: "loading" });
      void loadReport("wages", filters, controller.signal)
        .then((value) => setReport({ kind: "ready", value }))
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === "AbortError")) {
            setReport({ kind: "error", message: error instanceof Error ? error.message : "工资查询失败" });
          }
        });
    }, 200);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [filters]);

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
    const rows = new Map<string, { name: string; orderCount: Set<string>; amount: number }>();
    for (const row of value.rows) {
      const name = String(row.personName ?? "未知人员");
      const current = rows.get(name) ?? { name, orderCount: new Set<string>(), amount: 0 };
      current.orderCount.add(String(row.reworkNo ?? row.reworkOrderId ?? "未知返工单"));
      current.amount += Number(row.finalAmount ?? 0);
      rows.set(name, current);
    }
    return [...rows.values()].sort((left, right) => right.amount - left.amount);
  }, [value]);

  return (
    <div className="wage-page wage-management">
      <header className="page-heading">
        <div>
          <h1>工资管理</h1>
          <p>按工人、返工单、款号和期间交叉查询；金额直接读取服务端工资事实。</p>
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
          <label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <label>月结状态<select value={status} onChange={(event) => setStatus(event.target.value)}>{statusOptions.map(([item, label]) => <option key={item} value={item}>{label}</option>)}</select></label>
          {value?.canExport ? <a href={reportExportUrl("wages", filters)}><Button variant="primary">导出当前工资明细</Button></a> : null}
        </div>
      </Surface>

      {report.kind === "loading" ? <Surface>正在查询工资明细…</Surface> : null}
      {report.kind === "error" ? <Surface><p role="alert" className="form-message">{report.message}</p></Surface> : null}

      {value ? (
        <>
          <section className="wage-summary" aria-label="工资查询汇总">
            <Surface><small>当前明细</small><strong>{value.rowCount} 条</strong></Surface>
            {Object.entries(value.totals).map(([key, total]) => (
              <Surface key={key}><small>{businessFieldLabel(key)}</small><strong>{businessValue(key, total)}</strong></Surface>
            ))}
          </section>

          <Surface className="wage-person-summary">
            <div className="wage-section-heading">
              <div><h2>按工人汇总</h2><p>随上方姓名、订单与期间条件同步变化。</p></div>
              {value.truncated ? <StatusBadge tone="warning">明细超过 500 条，请缩小条件后核对汇总</StatusBadge> : null}
            </div>
            {personSummary.length ? (
              <div className="wage-person-grid">
                {personSummary.map((person) => (
                  <article key={person.name}>
                    <b>{person.name}</b>
                    <span>{person.orderCount.size} 张返工单</span>
                    <strong>¥{person.amount.toFixed(2)}</strong>
                  </article>
                ))}
              </div>
            ) : <p>当前条件没有工资数据。</p>}
          </Surface>

          <Surface className="wage-detail-table">
            <div className="wage-section-heading"><div><h2>逐单逐人工资明细</h2><p>每一行对应一名工人在一张返工单的一项工资。</p></div></div>
            <div className="reporting-table-wrap">
              <table>
                <thead><tr>{value.columns.map((column) => <th key={column.key}>{column.label}</th>)}</tr></thead>
                <tbody>{value.rows.map((row, index) => (
                  <tr key={index}>{value.columns.map((column) => <td key={column.key}>{businessValue(column.key, row[column.key])}</td>)}</tr>
                ))}</tbody>
              </table>
            </div>
            {value.rows.length === 0 ? <p>当前筛选范围没有工资明细。</p> : null}
          </Surface>
        </>
      ) : null}

      <section className="wage-period-section">
        <div className="wage-section-heading">
          <div><h2>月结批次</h2><p>进入月份后执行初核、行政复核、调整和锁定。</p></div>
        </div>
        {message ? <p role="alert" className="form-message">{message}</p> : null}
        <div className="wage-grid">
          {periods.map((period) => (
            <Surface key={period.periodId} className="wage-period-card">
              <div className="wage-period-card__heading">
                <a href={pageUrl(`ui/wages/${period.periodId}`)}><strong>{period.periodMonth.slice(0, 7)}</strong></a>
                <StatusBadge tone={period.status === "locked" ? "success" : "info"}>{statusLabel[period.status]}</StatusBadge>
              </div>
              <dl>
                <dt>工人 / 明细</dt><dd>{period.personCount} / {period.sourceItemCount}</dd>
                <dt>原始金额</dt><dd>¥{period.originalTotal}</dd>
                <dt>调整金额</dt><dd>¥{period.adjustmentTotal}</dd>
                <dt>最终金额</dt><dd><strong>¥{period.finalTotal}</strong></dd>
              </dl>
            </Surface>
          ))}
        </div>
        {periods.length === 0 && !message ? <Surface><p>暂无已通过整单审核的工资来源。</p></Surface> : null}
      </section>
    </div>
  );
}
