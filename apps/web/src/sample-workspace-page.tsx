import { todoReturnPath } from "./todo-query-state.js";
import {SampleAnalysisPage} from './sample-analysis-page.js';
import {SampleDisposalActions,SampleArchiveList,SampleFinancialHistory} from "./sample-disposal-page.js";
import { useEffect, useState } from "react";
import type { z } from "zod";
import {
  SampleListResponseSchema, SampleDetailResponseSchema, SampleOptionsSchema, SampleAmountsSchema,
  SampleHistoryResponseSchema, type SampleListResponse, type SampleDetailResponse, type SampleOptions,
  type SampleAmounts, type SampleHistoryResponse, type SampleStatus, type SampleView,
} from "@dx-rework/contracts";
import { Button, StatusBadge, Surface } from "@dx-rework/ui";
import { Header, Shell } from "./components.js";
import { ListPagination } from "./list-pagination.js";
import { createWebUrls } from "../url-contract.js";
import "./rework-v2-form.css";
import "./sample-workspace.css";
import "./sample-operations.css";
import { SampleCatalogRow, SampleThumbnail, sampleDisplayMoney, type SampleSelection } from "./sample-catalog.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);
import { SampleWorkflowActions, SampleBatchReturn } from "./sample-workflow-page.js";
import { SampleCreationLinks, SampleAttachments } from "./sample-create-page.js";

export const sampleStatusLabels: Record<SampleStatus, string> = {
  borrowed: "借出中", return_pending: "归还待确认", in_stock: "在库", borrow_pending: "借出待确认",
  disposal_pending: "处置待审批", loss_payment_pending: "遗失待赔付", sold: "已出售", gifted: "已赠送",
  scrapped: "已报废", lost: "已遗失（已赔付）", archived: "已归档",
};
const disposalLabels: Record<string, string> = { sale: "出售", gift: "赠送", scrap: "报废", loss: "遗失" };
const historyLabels: Record<string, string> = {
  initial_custody: "首次领用", borrow: "借出", ...disposalLabels,
  "sample.created": "建档", "sample.borrow_requested": "申请借出", "sample.borrow_confirmed": "确认交付",
  "sample.return_requested": "申请归还", "sample.return_confirmed": "确认收到",
  "sample.disposal_requested": "申请处置", "sample.disposal_approved": "批准处置", "sample.disposal_rejected": "拒绝处置",
  "sample.loss_closed": "确认赔付", "sample.cancelled": "撤销申请", "sample.basic_updated": "维护基本资料",
  "sample.finance_corrected": "更正财务资料", "sample.archived": "归档", "sample.restored": "恢复",
};
const requestStatusLabels: Record<string, string> = { pending: "待处理", payment_pending: "待赔付", completed: "已完成", rejected: "已拒绝", cancelled: "已撤销" };
const time = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "—";
export type SamplePageMode = "managed" | "pending" | "disposed" | "amounts" | "detail";
const titles: Record<SamplePageMode, string> = { managed: "在管样衣", pending: "待确认中心", disposed: "已处置样衣", amounts: "库存金额管理", detail: "样衣详情" };

async function request<T>(path: string, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(`samples${path}`), { credentials: "include", cache: "no-store", signal });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error?.message ?? "样衣资料加载失败，请重试");
  return schema.parse(body);
}

function SampleBadge({ status }: { status: SampleStatus }) {
  const tone = ["in_stock", "sold", "gifted", "scrapped", "lost"].includes(status) ? "success"
    : status.endsWith("pending") ? "warning" : status === "archived" ? "neutral" : "info";
  return <StatusBadge tone={tone}>{sampleStatusLabels[status]}</StatusBadge>;
}

export function SampleCard({ item }: { item: SampleView }) {
  return <SampleCatalogRow item={item} badge={<SampleBadge status={item.status} />} />;
}

export function SampleHistory({ sampleId, kind }: { sampleId: string; kind: "custody" | "disposal" | "audit" }) {
  const [data, setData] = useState<SampleHistoryResponse | null>(null), [page, setPage] = useState(1);
  const [error, setError] = useState(""), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setBusy(true); setError("");
    void request(`/${sampleId}/history?kind=${kind}&page=${page}`, SampleHistoryResponseSchema, abort.signal)
      .then(value => { if (!abort.signal.aborted) setData(value); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "历史加载失败"); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [sampleId, kind, page, retry]);
  return <div aria-busy={busy}>
    {error ? <p role="alert">{error} <Button onClick={() => setRetry(value => value + 1)}>重试</Button></p> : null}
    {data?.items.map(entry => <article className="sample-history-entry" key={entry.id}>
      <strong>{historyLabels[entry.kind] ?? "样衣操作"} · {entry.actorName}</strong>
      <p>{time(entry.occurredAt)}{entry.status ? ` · ${requestStatusLabels[entry.status] ?? entry.status}` : ""}</p>
      {entry.purpose ? <p>用途：{entry.purpose}</p> : null}
      {entry.returnedAt ? <p>归还：{time(entry.returnedAt)}</p> : null}
      {entry.disposedAt ? <p>处置结束：{time(entry.disposedAt)}</p> : null}
      {entry.recipient ? <p>接收对象：{entry.recipient}</p> : null}
      {entry.amount != null ? <p>金额：¥{entry.amount}</p> : null}
    </article>)}
    {!data && busy ? <p role="status">正在加载记录…</p> : null}
    {data && !data.totalCount ? <p>暂无记录</p> : null}
    {data ? <ListPagination page={data.page} totalPages={Math.max(1, Math.ceil(data.totalCount / 15))} busy={busy} onPageChange={setPage} ariaLabel="样衣历史分页" /> : null}
  </div>;
}

export function SampleDetail({ detail }: { detail: SampleDetailResponse }) {
  const item = detail.item;
  return <>
    <a href={pageUrl(todoReturnPath(window.location.search) ?? "ui/samples")}>{todoReturnPath(window.location.search) ? "返回我的待办" : "返回在管样衣"}</a>
    <header className="sample-detail-heading"><div><h2>{item.styleName}</h2><p>{item.sampleCode} · {item.styleNo}</p></div><SampleBadge status={item.status} /></header>
    <div className="sample-detail-grid"><Surface className="rework-v2-core"><div className="sample-detail-photo"><SampleThumbnail key={`${item.sampleId}:${item.version}`} sampleId={item.sampleId} large /></div></Surface><Surface className="rework-v2-core"><h2>样衣资料</h2>
      <dl className="sample-info">
        {Object.entries({ 品牌: item.brand, 款号: item.styleNo, 类别: item.category, 颜色: item.color, 尺码: item.size,
          部门: item.department, 采购人: item.purchaserName, 采购日期: item.purchaseDate, 当前持有人: item.holderName,
          用途: item.purpose, 借出时间: time(item.borrowedAt), 当前位置: item.storageLocation ?? (item.holderName ? `由${item.holderName}保管` : null), 备注: item.remark,
        }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "—"}</dd></div>)}
        {item.finance ? <div><dt>采购价</dt><dd>¥{sampleDisplayMoney(item.finance.purchasePrice)}</dd></div> : null}
      </dl>
    </Surface></div>
    <section id="sample-current-actions" aria-label="当前样衣操作">
    <SampleWorkflowActions key={`workflow-${item.version}`} sampleId={item.sampleId} />
    <SampleDisposalActions key={`disposal-${item.version}`} item={item} />
    </section>
    {item.finance?<SampleFinancialHistory key={`finance-${item.version}`} sampleId={item.sampleId}/>:null}
    <SampleAttachments key={`attachments-${item.version}`} sampleId={item.sampleId} />
    <Surface className="rework-v2-core"><details open><summary>借还记录</summary><SampleHistory key={item.version} sampleId={item.sampleId} kind="custody" /></details></Surface>
    <Surface className="rework-v2-core"><details><summary>处置记录</summary><SampleHistory key={item.version} sampleId={item.sampleId} kind="disposal" /></details></Surface>
    {detail.canViewAudit ? <Surface className="rework-v2-core"><details><summary>操作日志</summary><SampleHistory key={item.version} sampleId={item.sampleId} kind="audit" /></details></Surface> : null}
  </>;
}

function SampleWorkspaceContents({ mode = "managed", sampleId }: { mode?: SamplePageMode; sampleId?: string | undefined }) {
  const [data, setData] = useState<SampleListResponse | null>(null), [options, setOptions] = useState<SampleOptions | null>(null);
  const [detail, setDetail] = useState<SampleDetailResponse | null>(null), [amounts, setAmounts] = useState<SampleAmounts | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [view, setView] = useState("borrowed"), [filters, setFilters] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1), [busy, setBusy] = useState(true), [error, setError] = useState(""), [retry, setRetry] = useState(0);
  useEffect(() => { const refresh = () => setRetry(value => value + 1); window.addEventListener("sample-updated", refresh); return () => window.removeEventListener("sample-updated", refresh); }, []);
  const filter = (key: string, value: string) => { setFilters(old => ({ ...old, [key]: value })); setPage(1); };
  useEffect(() => {
    if (mode === "detail" || mode === "amounts") return;
    const abort = new AbortController();
    void request("/options", SampleOptionsSchema, abort.signal).then(value => { if (!abort.signal.aborted) setOptions(value); })
      .catch(e => { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "筛选资料加载失败"); });
    return () => abort.abort();
  }, [mode, retry]);
  useEffect(() => {
    const abort = new AbortController(); setBusy(true); setError("");
    const load = async () => {
      try {
        if (mode === "detail" && sampleId) {
          const value = await request(`/${sampleId}`, SampleDetailResponseSchema, abort.signal);
          if (!abort.signal.aborted) setDetail(value);
        } else if (mode === "amounts") {
          const value = await request("/amounts", SampleAmountsSchema, abort.signal);
          if (!abort.signal.aborted) setAmounts(value);
        } else {
          const params = new URLSearchParams({ page: String(page), view: mode === "managed" ? view : mode });
          for (const [key, value] of Object.entries(filters)) if (value.trim()) params.set(key, value.trim());
          const value = await request(`?${params}`, SampleListResponseSchema, abort.signal);
          if (!abort.signal.aborted) setData(value);
        }
      } catch (e) { if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "资料加载失败"); }
      finally { if (!abort.signal.aborted) setBusy(false); }
    };
    const timer = setTimeout(() => { void load(); }, filters.search ? 250 : 0);
    return () => { clearTimeout(timer); abort.abort(); };
  }, [mode, sampleId, view, filters, page, retry]);
  const renderRows = (selection?: SampleSelection) => <div className="sample-rows" aria-busy={busy}>{data?.items.map(item => <SampleCatalogRow item={item} badge={<SampleBadge status={item.status} />} selection={selection} key={item.sampleId} />)}</div>;
  return <Shell active={mode === "detail" ? "在管样衣" : titles[mode]}><div className={`rework-v2-page sample-workspace${mode === "amounts" ? "" : " sample-ops"}`}>
    <Header title={titles[mode]} subtitle={mode === "pending" ? "查看轮到你处理或与你相关的样衣事项。" : "查看样衣资料、实际保管状态与历史记录。"} badge="样衣管理" />
    {error ? <p role="alert">{error} <Button onClick={() => setRetry(value => value + 1)}>重试</Button></p> : null}
    {busy ? <p role="status">正在加载样衣资料…</p> : null}
    {mode === "detail" && detail && detail.item.sampleId.toLowerCase() === sampleId?.toLowerCase() ? <SampleDetail key={detail.item.sampleId} detail={detail} /> : null}
    {mode === "amounts" && amounts ? <Surface className="rework-v2-core"><dl className="sample-facts">
      {Object.entries({ 累计采购金额: amounts.purchaseTotal, 当前在管原值: amounts.managedOriginalValue,
        处置原值: amounts.disposedOriginalValue, 出售回款: amounts.saleReceipts, 遗失赔偿: amounts.lossCompensation,
      }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>¥{value}</dd></div>)}
    </dl><p>遗失待赔付不计入已收赔偿；已归档样衣不参与统计。</p></Surface> : null}
    {["managed", "pending", "disposed"].includes(mode) ? <>
      <div className="sample-overview-toolbar">{data ? <div className="sample-counts"><span>借出中 <b>{data.counts.borrowed}</b></span><span>在库 <b>{data.counts.inStock}</b></span><span>待确认 <b>{data.counts.pending}</b></span></div> : <span />}
      {mode === "managed" ? <SampleCreationLinks /> : null}</div>
      <Surface className="rework-v2-core sample-directory">
        {mode === "managed" ? <div className="sample-status-filter" aria-label="在管状态">
          {[["borrowed", "借出中"], ["in_stock", "在库"], ["managed", "全部在管"]].map(([value, label]) => <Button key={value} aria-pressed={view === value} variant={view === value ? "primary" : "secondary"} onClick={() => { setView(value!); setPage(1); filter("status", ""); }}>{label}</Button>)}
        </div> : null}
        <div className={`sample-filters sample-filters--${mode}`}>
          <label className="sample-search">样衣编号 / 款号<input aria-label="样衣编号或款号" placeholder="输入编号或款号的开头" maxLength={100} value={filters.search ?? ""} onChange={e => filter("search", e.target.value)} /></label>
          <div className="sample-extra-filters"><button type="button" className="sample-filters-toggle" aria-expanded={filtersOpen} onClick={() => setFiltersOpen(value => !value)}>持有人 / 品牌 / 部门 / 年份筛选{Object.entries(filters).some(([key,value]) => key !== "search" && value) ? "（已设置）" : ""}</button><div className={filtersOpen ? "is-open" : ""}>
          <label>采购年份<select className="rework-v2-control" value={filters.purchaseYear ?? ""} onChange={e => filter("purchaseYear", e.target.value)}><option value="">全部年份</option>{options?.purchaseYears.map(year => <option key={year}>{year}</option>)}</select></label>
          <label>{mode === "disposed" ? "相关人员" : "当前持有人"}<select className="rework-v2-control" value={filters[mode === "disposed" ? "personUserId" : "holderUserId"] ?? ""} onChange={e => filter(mode === "disposed" ? "personUserId" : "holderUserId", e.target.value)}><option value="">全部人员</option>{options?.people.map(person => <option value={person.userId} key={person.userId}>{person.name}</option>)}</select></label>
          <label>品牌<select className="rework-v2-control" value={filters.brand ?? ""} onChange={e => filter("brand", e.target.value)}><option value="">全部品牌</option>{options?.brands.map(brand => <option key={brand}>{brand}</option>)}</select></label>
          <label>部门<select className="rework-v2-control" value={filters.department ?? ""} onChange={e => filter("department", e.target.value)}><option value="">全部部门</option>{options?.departments.map(department => <option key={department}>{department}</option>)}</select></label>
          {mode === "disposed" ? <>
            <label>处置类型<select className="rework-v2-control" value={filters.disposalType ?? ""} onChange={e => filter("disposalType", e.target.value)}><option value="">全部类型</option>{Object.entries(disposalLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label>处置开始日期<input type="date" value={filters.disposedFrom ?? ""} onChange={e => filter("disposedFrom", e.target.value)} /></label>
            <label>处置结束日期<input type="date" value={filters.disposedTo ?? ""} onChange={e => filter("disposedTo", e.target.value)} /></label>
          </> : null}
          {mode === "pending" || (mode === "managed" && view === "managed") ? <label>状态<select className="rework-v2-control" value={filters.status ?? ""} onChange={e => filter("status", e.target.value)}><option value="">全部状态</option>{Object.entries(sampleStatusLabels).filter(([value]) => mode === "pending" ? value.endsWith("pending") : ["borrowed", "in_stock", "borrow_pending", "return_pending", "disposal_pending", "loss_payment_pending"].includes(value)).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label> : null}
          </div></div>
        </div>
        <div className="sample-table-head" aria-hidden="true"><span>选择</span><span>样衣 / 品牌类别</span><span>采购 / 持有人</span><span>状态</span><span>操作</span></div>
        {mode === "managed" && data ? <SampleBatchReturn key={`${view}:${page}:${JSON.stringify(filters)}:${retry}`} items={data.items} loading={busy} selectionScope={`${view}:${page}:${JSON.stringify(filters)}:${retry}`} renderRows={renderRows} /> : renderRows()}
      </Surface>
      {data && !data.items.length ? <p>{data.totalCount ? "本页暂无样衣，请返回第一页。" : "当前筛选暂无样衣"}</p> : null}
      {data ? <><p>共 {data.totalCount} 件</p><ListPagination page={data.page} totalPages={Math.max(1, Math.ceil(data.totalCount / 15))} busy={busy} onPageChange={setPage} ariaLabel="样衣列表分页" /></> : null}
      {mode === "managed" ? <SampleArchiveList /> : null}
    </> : null}
  </div></Shell>;
}

export function SampleWorkspacePage(props:{mode?:SamplePageMode;sampleId?:string|undefined}){return props.mode==="amounts"?<SampleAnalysisPage/>:<SampleWorkspaceContents {...props}/>;}

