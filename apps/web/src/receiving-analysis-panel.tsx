import { useEffect, useState } from "react";
import { Button, Surface } from "@dx-rework/ui";
import { ReceivingAnalysisQuerySchema, ReceivingAnalysisResponseSchema, type ReceivingAnalysisQuery, type ReceivingAnalysisResponse } from "@dx-rework/contracts";
import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import { verifySession } from "./auth.js";
import { createWebUrls } from "../url-contract.js";
import { ListPagination } from "./list-pagination.js";
import "./rework-v2-form.css";
import "./receiving-analysis.css";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const quantity = (value: string | null) => value === null ? "未记录" : formatBusinessDecimal(value, 0);
const labels: Record<ReceivingAnalysisQuery["fact"], string> = {all: "全部回货", receiving_difference: "回货有差异", packing_difference: "装箱有差异", missing_packing: "装箱未记录", handled: "已有处理记录"};
export function ReceivingAnalysisPanel({startDate, endDate, q}: {startDate: string; endDate: string; q: string}) {
  const [open, setOpen] = useState(false), [access, setAccess] = useState<"loading" | "allowed" | "denied">("loading");
  const [query, setQuery] = useState(() => ReceivingAnalysisQuerySchema.parse({startDate, endDate, q}));
  const [data, setData] = useState<ReceivingAnalysisResponse | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (!open) return;
    let active = true;
    void verifySession().then(session => {
      if (active) setAccess(session !== "denied" && session.status === "authorized" && (session.user.isRoot === true || !!session.user.businessRoles?.length) ? "allowed" : "denied");
    }).catch(() => { if (active) setAccess("denied"); });
    return () => { active = false; };
  }, [open]);
  useEffect(() => {
    if (!open || access !== "allowed") return;
    const abort = new AbortController(); setBusy(true); setError("");
    const params = new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
    void fetch(apiUrl(`receiving/analysis?${params}`), {credentials: "include", cache: "no-store", signal: abort.signal}).then(async response => {
      if (response.status === 401 || response.status === 403) { if (!abort.signal.aborted) { setData(null); setAccess("denied"); } throw new Error("当前身份无权查看回货分析。"); }
      if (!response.ok) throw new Error("回货分析读取失败，请重试；以下保留上次成功结果。");
      const next = ReceivingAnalysisResponseSchema.parse(await response.json()); if (!abort.signal.aborted) setData(next);
    }).catch(reason => { if (!abort.signal.aborted) setError(reason instanceof Error ? reason.message : "读取失败，请重试。"); })
      .finally(() => { if (!abort.signal.aborted) setBusy(false); });
    return () => abort.abort();
  }, [access, open, query, retry]);
  const change = (patch: Partial<ReceivingAnalysisQuery>) => setQuery({...data?.filters ?? query, page: 1, ...patch});
  return <section className="receiving-analysis">
    <Button className="ui-disclosure-trigger" variant="secondary" aria-expanded={open} onClick={() => setOpen(value => !value)}>回货与装箱分析{open ? " · 收起" : " · 展开"}</Button>
    {open && (access === "denied" ? <p role="alert">当前身份无权查看回货分析。</p> : access === "loading" ? <p role="status">正在核验权限…</p> : <>
      <div className="receiving-analysis-toolbar"><h2>差异事实与处理记录</h2><Button variant="secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>{busy ? "正在读取…" : "刷新分析"}</Button></div>
      <p>沿用订单回货的款号汇总。分批回货、未完成装箱仅表示当前差异，不判定最终损耗；已处理不代表差额归零。</p>
      <Button variant="secondary" disabled={busy} onClick={() => {
        const parsed = ReceivingAnalysisQuerySchema.safeParse({startDate, endDate, q});
        if (parsed.success) setQuery(parsed.data); else setError("请先检查订单回货日期范围。");
      }}>使用上方回货筛选</Button>
      {error && <p role="alert">{error}</p>}
      {data && <>
        <p className="receiving-analysis-scope">数据截至 {new Date(data.asOf).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"})} · {data.filters.q ? `全历史款号搜索：${data.filters.q}` : `${data.filters.startDate} 至 ${data.filters.endDate}期间出现的款号，实收累计至期末`} · 装箱取当前最新版本</p>
        <div className="receiving-analysis-tabs" aria-label="差异筛选">{Object.entries(labels).map(([key, label]) => <Button key={key} variant={data.filters.fact === key ? "primary" : "secondary"} disabled={busy} onClick={() => change({fact: key as ReceivingAnalysisQuery["fact"]})}>{label}</Button>)}</div>
        <Surface><dl className="receiving-analysis-metrics">
          <div><dt>符合条件款号</dt><dd>{quantity(String(data.summary.totalCount))}<small> / {quantity(data.summary.batchCount)}批</small></dd></div>
          <div><dt>送货单 / 累计实收</dt><dd>{quantity(data.summary.documentQuantity)} / {quantity(data.summary.actualQuantity)}</dd></div>
          <div><dt>回货差异合计</dt><dd>{quantity(data.summary.receivingDifference)}<small>绝对差额 {quantity(data.summary.receivingAbsoluteDifference)}</small></dd></div>
          <div><dt>已记录装箱 / 差异</dt><dd>{quantity(data.summary.packingQuantity)} / {quantity(data.summary.packingDifference)}</dd></div>
        </dl><p>装箱未记录 {quantity(data.summary.missingPackingCount)}款，不按零参与装箱合计；已有处理记录 {quantity(data.summary.handledCount)}款。</p></Surface>
        <p>未关联生产订单的收货 {quantity(data.summary.unlinkedReceiptCount)}次；关联排除对象 {quantity(data.summary.excludedReceiptCount)}次。回货原始事实仍保留，排除对象不展示供应商或生产信息。不按款号猜测订单、颜色或供应商。</p>
        {!data.items.length && <Surface><p>当前筛选没有回货记录。</p></Surface>}
        {data.items.map(item => <Surface key={item.receivingBatchId} className="receiving-analysis-row">
          <div className="receiving-analysis-toolbar"><h3>{item.styleNo}</h3><span>{item.batchIds.length}批 · 当前操作版本 {item.version}</span></div>
          <dl className="receiving-analysis-metrics"><div><dt>送货单 → 实收 → 装箱</dt><dd>{quantity(item.documentQuantity)} → {quantity(item.actualQuantity)} → {quantity(item.packingQuantity)}</dd></div><div><dt>回货差异</dt><dd>{quantity(item.receivingDifference)}<small>{item.receivingHandled ? "已有匹配处理" : "无当前匹配处理"}</small></dd></div><div><dt>装箱差异</dt><dd>{quantity(item.packingDifference)}<small>{item.packingHandled ? "已有匹配处理" : "无当前匹配处理"}</small></dd></div></dl>
          <details><summary>展开原单据与版本 · {item.receipts.length}次收货</summary>
            <p>款号汇总可能包含多个批次和生产订单；以下按收货 ID 展示明确关联，不能把整款差异归给某个供应商。</p>
            {item.receipts.map(receipt => <article key={receipt.receiptId} className="receiving-analysis-history"><strong>{receipt.excluded ? "关联生产已排除" : receipt.supplierName ?? "未关联供应商"}</strong><p>收货 {receipt.receiptId} · 批次 {receipt.receivingBatchId}</p><p>{new Date(receipt.receivedAt).toLocaleString("zh-CN", {timeZone: "Asia/Shanghai"})} · 单据 {quantity(receipt.documentQuantity)} · 本次实收 {quantity(receipt.actualQuantity)}</p><p>{receipt.contractNumber ? `合同 ${receipt.contractNumber} · 生产订单 ${receipt.productionOrderId}` : "暂无明确生产订单关联"}{receipt.correctionId ? ` · 修订 ${receipt.correctionId}` : " · 原始收货版本"}</p>{receipt.attachments.map(attachment => <a key={attachment.attachmentId} href={apiUrl(`tools/attachments/${attachment.attachmentId}/download?mode=inline`)} target="_blank" rel="noreferrer">查看送货单：{attachment.filename}</a>)}</article>)}
            <h4>装箱修订历史</h4>{item.packingHistory.length ? item.packingHistory.map(revision => <p key={revision.revisionId}>{revision.revisionId === item.packingRevisionId ? "当前有效 · " : "历史 · "}{quantity(revision.quantity)}件 · {revision.recordedAt} · 版本 {revision.revisionId} · 批次 {revision.receivingBatchId}</p>) : <p>尚无装箱记录。</p>}
            <h4>差异处理原始快照</h4>{item.resolutions.length ? item.resolutions.map(resolution => <article key={resolution.resolutionId} className="receiving-analysis-history"><strong>{resolution.type === "receiving" ? "回货" : "装箱"}处理：{resolution.result}</strong><p>单据 {quantity(resolution.documentQuantity)} · 实收 {quantity(resolution.actualQuantity)} · 装箱 {quantity(resolution.packingQuantity)} · 当时差额 {quantity(resolution.differenceQuantity)}</p><p>{resolution.handledAt} · 处理 {resolution.resolutionId} · 批次 {resolution.receivingBatchId}</p></article>) : <p>尚无处理记录。</p>}
            <p>历史差额按当时版本原样保留；旧方向记录不会被重算为当前方向。批次修正与逐次收货值可能不同，以顶部有效汇总为准。</p>
          </details>
        </Surface>)}
        <ListPagination page={data.filters.page} totalPages={Math.ceil(data.summary.totalCount / 15)} busy={busy} ariaLabel="回货分析分页" onPageChange={page => change({page})}/>
      </>}
    </>)}
  </section>;
}

