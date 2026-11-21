import { useEffect, useState } from "react";
import { Button } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { DigitalRequestError, digitalRequest } from "./digital-production-api.js";
import './cockpit-receipt-dialog.css';
import { ReceivingDialog } from "./receiving-dialog.js";

type ScopedReceiptDetail = {
  orderId: string;
  scope: "whole" | "visible";
  totals: { demand: number | null; received: number | null; remaining: number | null; excess: number | null };
  status: string;
  closed: boolean;
  history: {
    receipts: Array<{ receiptId: string; documentQuantity: number; actualQuantity: number; defectiveQuantity: number }>;
    corrections: Array<{ id: string; at: string; by: string | null; documentQuantity: number; actualQuantity: number; defectiveQuantity: number }>;
    packing: Array<{ id: string; at: string; by: string | null; quantity: number }>;
    resolutions: Array<{ id: string; at: string; by: string | null; differenceType: string; result: string }>;
  } | null;
  lines: Array<{
    lineId: string; poNumber: string | null; color: string; scope: "whole" | "visible";
    demand: number | null; received: number | null; documentQuantity: number | null; defectiveQuantity: number | null;
    packingQuantity: number | null;
    receivingResolution: string | null;
    packingResolution: string | null; receiptCount: number; status: string;
    records: Array<{ receiptId: string; receivedAt: string | null; receivedDate?: string | null; actualQuantity: number }>;
  }>;
  documents: Array<{ id: string; filename: string; image: boolean }>;
  boardUrl?: string;
};

const urls = createWebUrls(import.meta.env.BASE_URL);
const quantity = (value: number | null) => value === null ? "—" : Number(value).toLocaleString();
const observation = (at: string) => new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });

export function CockpitReceiptDialog({ orderId, label, onClose, returnFocus }: { orderId: string; label: string; onClose(): void; returnFocus: HTMLElement }) {
  const [detail, setDetail] = useState<ScopedReceiptDetail | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setDetail(null); setError("");
    void digitalRequest<ScopedReceiptDetail>(`orders/${orderId}/receipt-summary`, "GET", undefined, undefined, { signal: controller.signal })
      .then(value => {
        if (controller.signal.aborted) return;
        if (value.orderId !== orderId) throw new Error("收货明细与选中的订单不一致");
        setDetail(value);
      }).catch(reason => {
        if (controller.signal.aborted) return;
        setError(reason instanceof DigitalRequestError && [403, 404].includes(reason.status ?? 0)
          ? "当前订单没有可读取的收货范围。" : reason instanceof Error ? reason.message : "收货明细读取失败。");
      });
    return () => controller.abort();
  }, [orderId, attempt]);

  const current = detail?.orderId === orderId ? detail : null;
  const attachment = (id: string, mode: "thumbnail" | "preview" | "download") =>
    urls.apiUrl(`digital-production/orders/${orderId}/receipt-summary/attachments/${id}?mode=${mode}`);
  return (
    <ReceivingDialog title="本单收货明细" onClose={onClose} returnFocus={returnFocus}>
      <section className="cockpit-receipt-content">
      <header><h2>本单收货明细</h2><button type="button" onClick={onClose} aria-label="关闭本单收货明细">×</button></header>
      <p>{label}</p>
      {!current && !error && <p role="status">正在读取本单收货明细…</p>}
      {error && <><p role="alert">{error}</p><Button type="button" onClick={() => setAttempt(value => value + 1)}>重试读取</Button></>}
      {current && <>
        <p>{current.scope === "visible" && "可见范围 · "}{current.status}{current.closed && " · 已特殊结案"}</p>
        <dl>
          <div><dt>{current.scope === "visible" ? "可见范围应收" : "应收"}</dt><dd data-receipt-quantity="true">{quantity(current.totals.demand)}</dd></div>
          <div><dt>{current.scope === "visible" ? "可见范围实收" : "累计实收"}</dt><dd data-receipt-quantity="true">{quantity(current.totals.received)}</dd></div>
          <div><dt>{current.scope === "visible" ? "可见范围未收" : "未收"}</dt><dd data-receipt-quantity="true">{quantity(current.totals.remaining)}</dd></div>
          <div><dt>{current.scope === "visible" ? "可见范围超收" : "超收"}</dt><dd data-receipt-quantity="true">{quantity(current.totals.excess)}</dd></div>
        </dl>
        <ul>{current.lines.map(line => <li key={line.lineId}>
          <strong>PO {line.poNumber ?? "—"} · {line.color}</strong>
          {line.scope === "visible" && <span> · 可见范围</span>}
          <p>{line.status} · {quantity(line.received)}/{quantity(line.demand)} 件 · 收货 {line.receiptCount} 次</p>
          <p>送货单 {quantity(line.documentQuantity)} · 次品 {quantity(line.defectiveQuantity)} · 装箱 {quantity(line.packingQuantity)}</p>
          {line.receivingResolution && <p>收货差异处理：{line.receivingResolution}</p>}
          {line.packingResolution && <p>装箱差异处理：{line.packingResolution}</p>}
          {line.records.length > 0 && <details><summary>收货记录</summary>
            <ul>{line.records.map(row => <li key={row.receiptId}>{row.receivedDate ?? (row.receivedAt ? observation(row.receivedAt) : "—")} · {quantity(row.actualQuantity)} 件</li>)}</ul>
          </details>}
        </li>)}</ul>
        {current.history && <details><summary>收货及处理历史</summary>
          <ul>
            {current.history.receipts.map(row => <li key={row.receiptId}>原收货 · 送货单 {quantity(row.documentQuantity)} · 实收 {quantity(row.actualQuantity)} · 次品 {quantity(row.defectiveQuantity)}</li>)}
            {current.history.corrections.map(row => <li key={row.id}>收货更正 · {observation(row.at)} · {row.by ?? "—"} · 送货单 {quantity(row.documentQuantity)} · 实收 {quantity(row.actualQuantity)} · 次品 {quantity(row.defectiveQuantity)}</li>)}
            {current.history.packing.map(row => <li key={row.id}>装箱记录 · {observation(row.at)} · {row.by ?? "—"} · {quantity(row.quantity)} 件</li>)}
            {current.history.resolutions.map(row => <li key={row.id}>{row.differenceType === "packing" ? "装箱差异" : "收货差异"} · {observation(row.at)} · {row.by ?? "—"} · {row.result}</li>)}
          </ul>
        </details>}
        {current.documents.length > 0 && <details><summary>收货凭证</summary>
          <ul>{current.documents.map(row => <li key={row.id}>
            {row.image && <img src={attachment(row.id, "thumbnail")} alt="" loading="lazy" />}
            <a href={attachment(row.id, "preview")} target="_blank" rel="noreferrer">{row.filename}</a>
            <a href={attachment(row.id, "download")}>下载</a>
          </li>)}</ul>
        </details>}
      </>}
      <footer>{current?.boardUrl && <a href={urls.pageUrl(current.boardUrl)}>打开本单收货看板</a>}<Button type="button" onClick={onClose}>关闭</Button></footer>
      </section>
    </ReceivingDialog>
  );
}
