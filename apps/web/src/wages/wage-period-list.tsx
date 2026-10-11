import { readWageListQuery,wageListPath,wageSourcePath } from "./wage-query-state.js";
import { createWebUrls } from "../../url-contract.js";
import { NavigationIcon } from "../navigation-icons.js";
import type { ReportPreviewResponse } from "@dx-rework/contracts/reporting";
import { formatBusinessDecimal, isBusinessMoneyField } from "@dx-rework/contracts/business-display";
import { fixedBusinessCurrency as formatBusinessCurrency } from "../fixed-business-currency.js";
import { Button, InsetField, StatusBadge, Surface } from "@dx-rework/ui";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "../use-debounced-value.js";
import { useInternalReturnScroll } from "../use-internal-return-scroll.js";
import { businessFieldLabel, businessValue } from "../business-display.js";
import { ListPagination, LIST_PAGE_SIZE } from "../list-pagination.js";
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

const {pageUrl}=createWebUrls(import.meta.env.BASE_URL);
const pad = (value: number): string => String(value).padStart(2, "0");
const monthEnd = (year: number, month: number): string =>
  `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;

const mainFields=new Set(["personName","wageSource","wageKind","orderNo","styleNo","taskName","processName","wageAmount","completedDate","settlementStatus"]);
const basisFields=new Set(["unitPrice","sourceAmount","roundAmount","actualHours"]);
const wageCell=(key:string,value:string|number|boolean|null|undefined):string =>
  basisFields.has(key) && value != null ? formatBusinessDecimal(String(value),3) : value != null && isBusinessMoneyField(key) ? formatBusinessCurrency(String(value)) : businessValue(key,value);

const wageBasis=(row:ReportPreviewResponse["rows"][number]):string => {
  const number=(key:string) => row[key] == null ? "—" : formatBusinessDecimal(String(row[key]),3);
  if(row.wageKind === "pattern_rework") return `本段 ${number("sourceAmount")} 元 / 整轮 ${number("roundAmount")} 元`;
  if(row.wageKind === "misc") return `${number("actualHours")} 小时 × ${number("unitPrice")} 元/小时`;
  const unit=businessValue("unit",row.unit);
  return `${row.wageSource === "pattern_room" ? "整轮 " : ""}${number("quantity")} ${unit} × ${number("unitPrice")} 元/${unit}${row.wageSource === "pattern_room" ? `；本段 ${number("sourceAmount")} 元` : ""}`;
};

export function WagePeriodList() {
  const today = reportingBusinessDate();
  const [initial]=useState(()=>readWageListQuery(window.location.search));
  const [from, setFrom] = useState(initial.from??reportingBusinessMonthStart());
  const [to, setTo] = useState(initial.to??today);
  const [q, setQ] = useState<string>(initial.q??"");
  const [personType, setPersonType] = useState<string>(initial.personType??"");
  const [wageSource, setWageSource] = useState<string>(initial.wageSource??"");
  const [patternKind, setPatternKind] = useState<string>(initial.patternKind??"");
  const [status, setStatus] = useState<string>(initial.status??"");
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
    wageSource: wageSource || undefined, patternKind: patternKind || undefined, status:status || undefined,
  }), [from, to, debouncedQ, personType, wageSource, patternKind, status]);
  const resetKey=JSON.stringify(filters);
  const [pages,setPages]=useState({key:resetKey,detail:initial.page,person:initial.personPage});
  const currentPages=pages.key===resetKey?pages:{key:resetKey,detail:1,person:1};
  const requestedPage=currentPages.detail;
  const queryKey = JSON.stringify([filters,refresh,requestedPage]);
  const currentKey = useRef(queryKey);
  currentKey.current = queryKey;

  useEffect(() => {
    const controller = new AbortController();
    setReport((current) => current.kind === "ready" ? current : { kind: "loading" });
    void loadReport("wages", {...filters,page:String(requestedPage)}, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setReport({ kind: "ready", value, key: queryKey }); })
      .catch((error: unknown) => {
        if (!(error instanceof DOMException && error.name === "AbortError")) {
          setReport({ kind: "error", message: error instanceof Error ? error.message : "工资查询失败" });
        }
      });
    return () => {
      controller.abort();
    };
  }, [filters,queryKey,requestedPage]);

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
  const settle = async () => {
    if (stale || busyRef.current || !value?.canSettleWages || !value.wageSummary?.pendingLineCount) return;
    busyRef.current = true; setBusy(true); setMessage("");
    const keyAtStart = queryKey;
    try {
      const preview = await previewWageSettlement(filters);
      if (currentKey.current !== keyAtStart) return;
      if (!preview.lineCount) { setRefresh(n=>n+1); return; }
      if (!await confirmInApp(`将当前筛选范围内的 ${formatBusinessDecimal(preview.personCount)} 名工人、${formatBusinessDecimal(preview.lineCount)} 条未结算明细登记为已结算？此操作只记录结算状态。`)) return;
      if (currentKey.current !== keyAtStart) return;
      const result = await markWageSettlement(filters,preview.lineIds);
      setMessage(`已标记 ${formatBusinessDecimal(result.markedCount)} 条工资明细的结算状态。`);
      setRefresh(n=>n+1);
    } catch(error) {setMessage(error instanceof Error ? error.message : "工资结算标记失败");setRefresh(n=>n+1);}
    finally {busyRef.current=false;setBusy(false);}
  };
  const paginate=<T,>(items:readonly T[],kind:"person"|"detail")=>{
    const totalPages=Math.max(1,Math.ceil(items.length/LIST_PAGE_SIZE));
    const page=Math.min(currentPages[kind],totalPages);
    return {page,totalPages,items:items.slice((page-1)*LIST_PAGE_SIZE,page*LIST_PAGE_SIZE),
      setPage:(next:number)=>setPages({...currentPages,[kind]:next})};
  };
  const personPage=paginate(personSummary,"person");
  const detailPage={items:value?.rows??[],page:value?.pagination?.page??requestedPage,totalPages:value?.pagination?.totalPages??1,
    setPage:(next:number)=>setPages({...currentPages,detail:next})};
  const listPath=wageListPath({...filters,page:detailPage.page,personPage:personPage.page});
  useEffect(()=>{if(!stale)window.history.replaceState(window.history.state,"",pageUrl(listPath));},[listPath,stale]);
  useInternalReturnScroll(!stale);
  const sourceCell=(row:ReportPreviewResponse["rows"][number])=>{
    const target=wageSourcePath(row,listPath);
    return target?<a href={pageUrl(target)}>{wageCell("orderNo",row.orderNo)}</a>:<>{wageCell("orderNo",row.orderNo)}<small>{row.sourceStatus==="missing"?"历史来源未关联":"来源暂不可回查"}</small></>;
  };

  return (
    <div className="wage-page wage-management">
      <header className="page-heading">
        <div>
          <h1><NavigationIcon route="/ui/wages" size="title" />工资管理</h1>
          <p>按人员、工资来源、订单和劳动完成月份查询，统一核对并登记结算状态。</p>
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
            label="工人 / 订单 / 款号 / 杂事"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            placeholder="输入姓名、单号、款号或杂事名称"
          />
          <label>工人类型<select value={personType} onChange={event=>setPersonType(event.target.value)}><option value="">全部</option><option value="internal">正式工</option><option value="temporary">临时工</option></select></label>
          <label>开始日期<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label>
          <label>结束日期<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label>
          <label>工资来源<select value={wageSource} onChange={event=>{setWageSource(event.target.value);setPatternKind("");}}><option value="">全部来源</option><option value="order_rework">订单返工</option><option value="pattern_room">订单打板</option></select></label>
          {wageSource === "pattern_room" ? <label>板房类型<select value={patternKind} onChange={event=>setPatternKind(event.target.value)}><option value="">全部类型</option><option value="first_pattern">首次打板</option><option value="pattern_rework">打板返工</option><option value="misc">杂事</option></select></label> : null}
          <label>结算状态<select value={status} onChange={event=>setStatus(event.target.value)}><option value="">全部</option><option value="unsettled">未结算</option><option value="settled">已结算</option></select></label>
          <label>工资月份<input type="month" value={from.slice(0,7) === to.slice(0,7) ? from.slice(0,7) : ""} onChange={event=>{const month=event.target.value;if(month){setFrom(`${month}-01`);setTo(monthEnd(Number(month.slice(0,4)),Number(month.slice(5,7))));}}} /></label>
          <div className="wage-query-actions">
            {value?.canSettleWages ? <Button disabled={stale || busy || !value.wageSummary?.pendingLineCount} onClick={()=>void settle()}>登记结算状态</Button> : null}
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
            {Object.entries(value.totals).map(([key, total]) => (
              <Surface key={key}><small>{businessFieldLabel(key)}</small><strong>{wageCell(key, total)}</strong></Surface>
            ))}
          </section>
          <p>{formatBusinessDecimal(value.wageSummary?.personCount ?? 0)} 人 · {formatBusinessDecimal(value.wageSummary?.orderCount ?? 0)} 单 · {formatBusinessDecimal(value.wageSummary?.roundCount ?? 0)} 个板房轮次 · {formatBusinessDecimal(value.wageSummary?.rowCount ?? value.rowCount)} 条工资明细</p>

          <Surface className="wage-person-summary">
            <div className="wage-section-heading">
              <div><h2>按工人汇总</h2><p>随上方姓名、订单与期间条件同步变化。</p></div>
              <span>汇总、导出及结算状态登记均按完整筛选范围。</span>
            </div>
            {personSummary.length ? (
              <div className="wage-person-grid">
                {personPage.items.map((person) => (
                  <article key={person.personId}>
                    <b>{person.name}</b>
                    <span>{formatBusinessDecimal(person.orderCount)} 单 · {formatBusinessDecimal(person.lineCount)} 条</span>
                    <strong>{formatBusinessCurrency(person.amount)}</strong>
                    <details><summary>查看来源构成</summary>{person.sources.map(source=><p key={`${source.source}:${source.kind}`}>{businessValue("wageKind",source.kind)} · {formatBusinessDecimal(source.lineCount)} 条 · {formatBusinessCurrency(source.amount)}</p>)}</details>
                  </article>
                ))}
              </div>
            ) : <p>当前条件没有工资数据。</p>}
            <ListPagination page={personPage.page} totalPages={personPage.totalPages} onPageChange={personPage.setPage} ariaLabel="工人工资汇总分页" />
          </Surface>

          <Surface className="wage-detail-table">
            <div className="wage-section-heading"><div><h2>逐单逐人工资明细</h2><p>按本人执行段核对费用；整轮数量仅说明本轮计价依据，不代表每人重复完成该数量。</p></div></div>
            <div className="reporting-table-wrap">
              <table>
                <thead><tr>{value.columns.filter(column=>mainFields.has(column.key)).map(column=><th key={column.key}>{column.label}</th>)}<th>费用依据</th></tr></thead>
                <tbody>{detailPage.items.map(row=>(
                  <tr key={String(row.lineId)}>{value.columns.filter(column=>mainFields.has(column.key)).map(column=><td key={column.key}>{column.key === "settlementStatus" ? <StatusBadge tone={row[column.key] === "settled" ? "success" : "warning"}>{row[column.key] === "settled" ? "已结算" : "未结算"}</StatusBadge> : column.key === "orderNo" ? sourceCell(row) : wageCell(column.key,row[column.key])}</td>)}
                    <td><p>{wageBasis(row)}</p>{row.cancellation ? <p>取消部分计薪</p> : null}<details><summary>展开依据</summary><dl>{value.columns.filter(column=>!mainFields.has(column.key)).map(column=><Fragment key={column.key}><dt>{column.label}</dt><dd>{wageCell(column.key,row[column.key])}</dd></Fragment>)}</dl></details></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            {value.rows.length === 0 ? <p>当前筛选范围没有工资明细。</p> : null}
            <ListPagination page={detailPage.page} totalPages={detailPage.totalPages} onPageChange={detailPage.setPage} ariaLabel="工资明细分页" busy={stale} />
          </Surface>
        </>
      ) : null}


    </div>
  );
}
