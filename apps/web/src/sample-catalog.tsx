import { useEffect, useState, type ReactNode } from "react";
import { SampleAttachmentListSchema, type SampleView } from "@dx-rework/contracts";
import { Button } from "@dx-rework/ui";
import { createWebUrls } from "../url-contract.js";
import { sampleRequest } from "./sample-request.js";

const { apiUrl, pageUrl } = createWebUrls(import.meta.env.BASE_URL);

import { sampleDisplayMoney } from './sample-catalog-model.js';
export { sampleDisplayMoney } from './sample-catalog-model.js';

export function SampleThumbnail({ sampleId, large = false }: { sampleId: string; large?: boolean }) {
  const [fileId, setFileId] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "empty" | "error">("loading");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController(); setFileId(null); setState("loading");
    void sampleRequest(apiUrl(`samples/${sampleId}/attachments`), SampleAttachmentListSchema, { signal: abort.signal })
      .then(value => {
        if (abort.signal.aborted) return;
        const image = value.attachments.find(file => file.purpose === "sample_image");
        setFileId(image?.attachmentId ?? null); setState(image ? "ready" : "empty");
      }).catch(() => { if (!abort.signal.aborted) setState("error"); });
    return () => abort.abort();
  }, [sampleId, retry]);
  const className = large ? "sample-photo-large" : "sample-thumb";
  if (state === "ready" && fileId) return <img className={className} loading="lazy" src={apiUrl(`samples/${sampleId}/attachments/${fileId}/download`)} alt="样衣图片" onError={() => setState("error")} />;
  return <span className={`${className} sample-no-photo`}>{state === "loading" ? "图片加载中" : state === "error" ? <Button className="sample-image-retry" onClick={event => { event.preventDefault(); setRetry(value => value + 1); }}>重试图片</Button> : "暂无图片"}</span>;
}

export type SampleSelection = { selected: string[]; eligibleIds: string[]; disabled: boolean; onSelect(ids: string[]): void };

export function SampleCatalogRow({ item, badge, selection }: { item: SampleView; badge: ReactNode; selection?: SampleSelection | undefined }) {
  const href = pageUrl(`ui/samples/${item.sampleId}`);
  return <article className={`sample-row${selection?.selected.includes(item.sampleId) ? " is-selected" : ""}`}>
    <label className="sample-select"><input type="checkbox" aria-label={`选择 ${item.sampleCode}`} checked={selection?.selected.includes(item.sampleId) ?? false} disabled={!selection || selection.disabled || !selection.eligibleIds.includes(item.sampleId)} onChange={event => selection?.onSelect(event.target.checked ? [...selection.selected, item.sampleId] : selection.selected.filter(id => id !== item.sampleId))} /></label>
    <div className="sample-identity"><SampleThumbnail key={`${item.sampleId}:${item.version}`} sampleId={item.sampleId} /><a className="sample-identity" href={href}><span><strong>{item.styleName}</strong><small>{item.sampleCode}{item.styleNo ? ` · ${item.styleNo}` : ""}</small><small>{item.brand} · {item.category || "未分类"} · {item.color}{item.size ? ` / ${item.size}` : ""}</small></span></a></div>
    <div className="sample-holder"><strong>{item.holderName ?? "在库"}</strong><span>{item.department} · {item.storageLocation ?? (item.holderName ? "由持有人保管" : "—")}</span><small>{item.purchaseDate} 采购{item.finance ? <b>¥{sampleDisplayMoney(item.finance.purchasePrice)}</b> : null}</small>{item.purpose ? <small>用途：{item.purpose}</small> : null}{item.borrowedAt ? <small>借出：{new Date(item.borrowedAt).toLocaleDateString("zh-CN", { timeZone: "Asia/Shanghai" })}</small> : null}</div>
    <div className="sample-row-status">{badge}</div><div className="sample-row-actions"><a href={href}>详情</a><a href={`${href}#sample-current-actions`}>当前操作</a></div>
  </article>;
}
